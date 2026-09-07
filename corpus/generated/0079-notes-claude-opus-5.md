# Dedup at Ingest: Three Candidate Designs for the Halyard Pipeline

**Author:** R. Okonjo-Vance · **Reviewers:** T. Baird, M. Lindqvist
**Doc ID:** HAL-RN-0142 · **Revision:** 4 · **Status:** *draft, circulating for comment*

---

## 1. Problem statement

Halyard ingests device telemetry from roughly **41,000 field units**. Each unit emits a batch every 15 seconds and retries aggressively on any transport hiccup, which means the ingest tier routinely sees the same logical event two to five times. Downstream billing rollups are *not* idempotent, so duplicates translate directly into invoice errors — we logged 312 credit adjustments last quarter, and the support cost per adjustment is estimated at $28.

We need a dedup layer that sits between the edge collectors and the columnar store. Requirements agreed with the platform group on 3 March:

- **Throughput floor:** 180,000 events/sec sustained, 260,000/sec burst for up to 90 seconds.
- **Dedup window:** at least 6 hours. Field units have been observed replaying a full 4-hour buffer after a cellular outage.
- **False-drop budget:** ==zero tolerated false positives on billing-class events==. A false *negative* (letting a duplicate through) is recoverable via nightly reconciliation; a false positive silently destroys revenue data.
- **Added p99 latency:** ≤ 12 ms.
- **Operational:** must survive the loss of a single availability zone without a manual failover step.

The event key is a composite of `unit_id`, `sequence_no`, and `emit_epoch_ms`. Keys are 22 bytes after our varint packing.

---

## 2. Approach A — In-process sharded Bloom filters

Each ingest worker keeps a rotating set of Bloom filters in its own heap. Events are consistently hashed by `unit_id` at the load balancer so that a given unit always lands on the same worker, making the local filter authoritative for that unit.

### Structure

- Twelve filters per worker, each covering a 30-minute slice.
  - On slice rollover, the oldest filter is dropped and a fresh one allocated.
  - Lookup checks all twelve; insert touches only the newest.
    - Sizing: 8.2 million expected keys per slice at 0.1% target FPR → ~14 MB per filter, ~170 MB resident per worker.
      - Measured RSS on the prototype was **203 MB**, the gap being allocator slack and the rehash scratch buffer.

### Notes

*Fast.* The prototype (`halyard-bloom` branch, commit `a41f9c`) held **340,000 lookups/sec per core** on the c-class nodes, and p99 added latency was 0.4 ms. That is an order of magnitude of headroom.

The killer is the false-positive semantics. A Bloom filter cannot tell you a key is present, only that it is *probably* present — which is exactly backwards from our requirement. At 0.1% FPR against 180k events/sec, we would silently drop roughly **648 legitimate events per hour**. Driving the FPR to 10⁻⁹ pushes each filter to 106 MB and worker RSS past 1.3 GB, which breaks the node budget.

We also inherit a hard coupling to sticky routing. When a worker restarts, its filter is empty and we replay duplicates for up to 6 hours until the slices refill. T. Baird proposed warm-starting from a snapshot in object storage; that adds a 40-second startup penalty and a new failure mode we would rather not own.

---

## 3. Approach B — Centralised key store (Vessel cluster)

Push the seen-set into a shared in-memory store. We evaluated our existing **Vessel** cluster (the internal fork we run for session data) with a 6-hour TTL on every key.

```go
// dedupe/vessel.go — checked in on the hal-vessel-spike branch
package dedupe

import (
	"context"
	"errors"
	"time"
)

const (
	dedupWindow  = 6 * time.Hour
	claimTimeout = 8 * time.Millisecond
)

var ErrStoreUnavailable = errors.New("vessel: no quorum")

// Claim returns true if this caller is the first to observe key.
// A miss (store unavailable) fails open: we prefer a duplicate
// over a dropped billing event.
func (c *Client) Claim(ctx context.Context, key []byte) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, claimTimeout)
	defer cancel()

	slot := c.ring.Route(key)
	ok, err := slot.SetIfAbsent(ctx, key, marker{At: time.Now()}, dedupWindow)
	switch {
	case errors.Is(err, ErrStoreUnavailable):
		c.metrics.FailOpen.Inc()
		return true, nil // let it through; reconciliation will catch it
	case err != nil:
		return true, err
	}
	return ok, nil
}
```

### Trade-offs

- **Correctness:** exact. No probabilistic dropping. This is the single strongest argument in its favour.
- **Memory:** 22-byte keys plus Vessel's per-entry overhead (measured at 71 bytes) over a 6-hour window at 180k/sec gives **~3.6 TB**. That is 14 nodes at the current instance shape, roughly *4.1× our entire existing Vessel footprint*.
- **Latency:** median 1.9 ms, p99 **9.7 ms** under synthetic load — inside budget, but only just, and that was with the cluster otherwise idle.
- **Blast radius:** the fail-open path above is honest but ugly. During the 22 January Vessel incident we would have failed open for 51 minutes, admitting an estimated 4.1 million duplicates.

M. Lindqvist raised a fair point in review: we would be making the billing path depend on a cluster whose current SLO is 99.9%, which is *weaker* than the ingest tier's own 99.95%.

---

## 4. Approach C — Deferred dedup via merge-on-read

Do nothing at ingest. Write everything, tag each row with the composite key, and let the storage layer collapse duplicates when a query or rollup reads the segment.

### Mechanics

- Segments are written immutable, sorted by `(unit_id, sequence_no, emit_epoch_ms)`.
  - The reader performs a streaming dedup over the sorted key prefix.
    - Because duplicates are adjacent after sort, this is a single-pass comparison with no auxiliary memory.
      - Cost measured on a 2.1 GB segment: **117 ms** added to a full scan, ~4% overhead.
- A background compactor rewrites segments older than 8 hours with duplicates physically removed.
  - Compaction runs at 03:00 local, currently has 6 hours of idle capacity.

### Trade-offs

**Ingest cost is zero.** No new service, no new dependency, no latency added at all. Storage grows by the duplicate rate — currently 2.3×, which at our retention works out to an extra **$3,100/month** before compaction reclaims it (and about $410/month after).

The problems are downstream. Every consumer must now be dedup-aware; we counted **nine** independent readers, three of which are owned by other teams. Any new query path is a correctness hazard by default. Streaming consumers that read the tail of a segment before compaction see duplicates and must handle them themselves — which just relocates the problem rather than solving it.

---

## 5. Comparison

| Criterion | A: Bloom | B: Vessel | C: Merge-on-read |
|---|---|---|---|
| Exactness | probabilistic | **exact** | **exact** |
| Added p99 latency | 0.4 ms | 9.7 ms | 0 ms |
| New infra cost/mo | ~$0 | ~$9,400 | ~$410 |
| Restart behaviour | poor | good | n/a |
| Consumer burden | none | none | **high** |
| Blast radius | worker-local | cluster-wide | query-local |

---

## 6. Open items

- [x] Benchmark Bloom prototype at 260k/sec burst
- [x] Size Vessel memory requirement with real key distribution
- [x] Measure merge-on-read scan overhead on production-shaped segments
- [ ] Audit all nine downstream readers for dedup-awareness
- [ ] Prototype a **hybrid**: Approach C as the correctness backstop, Approach A as a best-effort ingest filter tuned for a *very* low insert-side FPR, accepting that it only reduces volume rather than guaranteeing uniqueness
- [ ] Confirm compactor headroom holds if retention moves from 30 to 90 days
- [ ] Get a written position from the billing team on tolerable reconciliation lag

---

## 7. Current leaning

I favour the **hybrid** listed above. Approach C alone is correct but pushes an unbounded maintenance tax onto other teams. Approach B is correct and clean but expensive and adds a dependency in the worst possible place. Approach A alone is disqualified outright by the false-positive requirement — but it becomes *safe* the moment it is only used to shed load in front of a system that is already exactly correct, because a false positive there costs us nothing but a slightly larger segment.

Proposed next step: two-week spike, target a 70% ingest volume reduction from the Bloom stage while keeping merge-on-read as the authority. Review 21 April.
