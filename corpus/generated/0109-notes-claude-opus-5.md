# Research Notes — Duplicate Suppression for the Harborlight Ingest Path

**Doc ID:** RN-2291
**Owner:** D. Krastev (Ingest Platform)
**Reviewers:** M. Oyelaran, P. Sandoval-Reyes, T. Ibbotson
**Status:** Draft 3 — circulated for comment before the 14 Nov design review
**Related:** RN-2244 (partition rebalancing), INC-8817 (double-billed telemetry, Aug)

---

## 1. Problem statement

Harborlight ingests device telemetry from roughly 4.1 million edge units. Units retry aggressively on any non-2xx response, and our load balancer terminates connections at 30 s, so a slow downstream write frequently produces a successful insert *and* a client retry. Post-INC-8817 audit found that **0.42%** of records in the `telemetry_raw` table were exact duplicates over a 30-day window, and that duplicates skewed the aggregate billing rollups by roughly $18.4k in a single month.

We need duplicate suppression at the ingest edge, before records reach the columnar store. The record carries a client-generated `emit_id` (UUIDv7-ish, monotonic-ish per device) plus `device_id` and `emitted_at`.

### Hard constraints

- p99 added latency ≤ **6 ms** per record at 240k records/sec sustained, 610k peak.
- Duplicate escape rate ≤ **1 in 10⁶** for records emitted within a 45-minute window.
- Must survive loss of a single availability zone with no more than 90 s of degraded suppression.
- No change to the edge firmware for at least two release trains (~7 months). Whatever we build has to work with the `emit_id` we already get.

### Soft goals

- Marginal infra cost under **$5,200/month** at current volume.
- Debuggable: an on-call engineer should be able to answer "why was record X dropped?" within five minutes.

---

## 2. Candidate approaches

Three designs survived the initial screen. A fourth (push dedupe into the columnar store via `MERGE` on a unique key) was cut early — the store's merge path costs us ~340 ms p99 per batch and would blow the latency budget by two orders of magnitude.

### Approach A — Centralized key store (Redis-compatible cluster, `SET NX` semantics)

Every ingest worker performs a conditional write of `emit_id` into a sharded in-memory store with a 45-minute TTL. If the key already exists, the record is dropped and a counter is incremented.

**Why it's attractive:** conceptually trivial, exact (no false positives), and the failure semantics are legible. We already run a managed key-value cluster for session affinity, so the operational muscle exists.

**Concerns:** it puts a synchronous network hop on the hot path, and it makes the ingest tier's availability a product of the key store's availability. At 240k rps with a 45-min TTL we hold roughly 648M live keys; at ~78 bytes of overhead per key that's ~50 GB of resident memory before replication, ~101 GB with a single replica.

### Approach B — Partition-local rotating filter (cuckoo filter, three-generation ring)

Each ingest worker owns a set of Kafka-style partitions keyed by `device_id`, so all records for a device land on one worker. The worker keeps three cuckoo filters covering 20-minute generations; lookups check all three, inserts go to the newest. Generations rotate on a wall-clock boundary and the oldest is dropped.

**Why it's attractive:** zero network hops. Memory footprint is tiny — a cuckoo filter sized for 3.2×10⁸ entries at a 1e-7 target FPR needs about 1.4 GB per generation with 4-byte fingerprints and load factor 0.94.

**Concerns:** probabilistic, so it *drops legitimate records* at the false-positive rate. Also depends entirely on partition stickiness; a rebalance moves a device to a cold worker whose filters don't contain its history. State must be checkpointed or rebuilt.

### Approach C — Per-device high-water mark (sequencer + watermark table)

Exploit the fact that `emit_id` is monotonic per device. Store, per `device_id`, the highest `emit_id` observed. Reject anything at or below the watermark. State is 4.1M rows instead of 648M keys — small enough to shard across worker-local LMDB with periodic replication.

**Why it's attractive:** state is bounded by device count, not by event rate. Two orders of magnitude cheaper than A.

**Concerns:** correctness hinges on monotonicity we do not actually control. Firmware audit (v2.8 through v3.4) shows the counter resets on hard reboot in **~0.9%** of units, and 11 fleet SKUs derive `emit_id` from a clock that can step backwards after NTP sync. Out-of-order-but-legitimate records get silently eaten.

---

## 3. Prototype and measurements

All three prototyped against a 90-minute replay of production traffic from 2 Oct (peak 587k rps), on `c7-xlarge` workers, 12 nodes.

| Metric | A: Central KV | B: Rotating filter | C: Watermark |
|---|---:|---:|---:|
| p50 added latency | 1.9 ms | 0.06 ms | 0.11 ms |
| p99 added latency | 7.4 ms | 0.21 ms | 0.38 ms |
| p99.9 added latency | 41 ms | 0.9 ms | 2.1 ms |
| Duplicate escape rate | 0 | 0 | 4.1e-5 |
| False-drop rate | 0 | 9.2e-8 | 3.7e-4 |
| Steady-state memory / node | 0.4 GB | 4.3 GB | 0.7 GB |
| Est. monthly cost | $9,880 | $3,150 | $2,240 |
| Recovery after AZ loss | 22 s | 165 s | 48 s |

Approach A **fails the latency constraint** at p99 (7.4 ms vs. 6 ms budget). Pipelining conditional writes in batches of 32 brought p99 to 4.8 ms but introduced a 40 ms batching delay at low volume, which broke the smoke tests for the alerting path.

Approach C's false-drop rate of 3.7e-4 is dominated by the reboot-reset cohort, exactly as predicted. That's ~89 legitimate records dropped per second at peak. Unacceptable without a firmware fix we can't ship for seven months.

Approach B is the only one that clears every hard constraint, but the 165 s recovery is over the 90 s degraded-suppression budget.

---

## 4. Fixing B's recovery gap

The rebuild cost comes from replaying the partition log to reconstruct filters. Two mitigations tested:

1. **Checkpoint filters to object storage every 60 s.** A generation serializes to ~1.4 GB; compressed with a fingerprint-aware packer we got it to 890 MB, restoring in 71 s. Marginal.
2. **Warm standby per partition.** A shadow worker consumes the same partition and maintains parallel filters, promoting on failure. Recovery drops to **8 s**, at the cost of doubling filter memory (8.6 GB/node) and adding ~$1,900/month.
3. **Hybrid: standby for the newest generation only, checkpoints for the older two.** Recovery of 14 s, memory 5.7 GB/node, cost delta $740/month. This is the recommendation.

Sketch of the generation ring as prototyped:

```python
import time
from dataclasses import dataclass, field

GEN_SECONDS = 1200          # 20 minutes
RING_DEPTH = 3              # covers a 60-minute lookback

@dataclass
class GenerationRing:
    """Three-generation cuckoo ring. Not thread-safe; one per partition."""
    make_filter: callable
    ring: list = field(default_factory=list)
    epoch: int = 0
    drops: int = 0
    inserts: int = 0

    def __post_init__(self):
        self.ring = [self.make_filter() for _ in range(RING_DEPTH)]
        self.epoch = int(time.time()) // GEN_SECONDS

    def _rotate_if_needed(self, now: float) -> None:
        current = int(now) // GEN_SECONDS
        elapsed = current - self.epoch
        if elapsed <= 0:
            return
        for _ in range(min(elapsed, RING_DEPTH)):
            stale = self.ring.pop()          # oldest generation
            stale.reset()                    # reuse the allocation
            self.ring.insert(0, stale)
        self.epoch = current

    def admit(self, emit_id: bytes, now: float | None = None) -> bool:
        """Return True if the record is novel and should be forwarded."""
        now = now if now is not None else time.time()
        self._rotate_if_needed(now)
        for gen in self.ring:
            if gen.contains(emit_id):
                self.drops += 1
                return False
        if not self.ring[0].insert(emit_id):
            # Newest generation is saturated: fail open, forward downstream.
            self.inserts += 1
            return True
        self.inserts += 1
        return True
```

Note the fail-open branch. Under saturation we prefer a duplicate over a silent drop — INC-8817 taught us that billing over-counts are recoverable and telemetry gaps are not.

---

## 5. Open questions

1. Does partition stickiness hold under the new rebalancer from RN-2244? Sandoval-Reyes believes the sticky assignor still reshuffles ~3% of partitions per deploy. If so, B needs a handoff protocol, not just checkpoints.
2. Can we layer C *behind* B as a cheap second filter for the 99.1% of devices with well-behaved counters, tagging the reboot-reset SKUs as exempt? Estimated to cut B's memory by 35%, but adds a maintained SKU allowlist — an operational liability.
3. What is the actual cost of a false drop? Product has not given us a number. If a dropped record is worth less than $0.0004 in downstream value, C alone becomes defensible and we should revisit.
4. Should the fail-open threshold be tunable per tenant? Two enterprise accounts have contractual exactly-once language that our current design does not literally satisfy.

---

## 6. Work items

- [x] Replay harness against 2 Oct traffic capture
- [x] Cuckoo filter benchmark, 4-byte vs. 8-byte fingerprints
- [x] Firmware audit for
