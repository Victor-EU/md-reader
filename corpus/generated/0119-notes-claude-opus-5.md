# Research Notes — Duplicate Suppression at Ingest (Project Marlin)

**Author:** D. Ferreira-Lang
**Reviewers:** R. Okonjo, L. Vandersteen
**Doc ID:** MRL-NOTE-0142 · Revision 3
**Status:** Draft for design review, cycle 7

## Problem statement

The Marlin ingest tier receives telemetry from roughly 62,000 edge agents. Agents retry aggressively on any non-2xx response, and our load balancer occasionally replays a request after a backend timeout. Measured duplicate rate over a two-week capture window was **2.7%** of all events, spiking to **11.4%** during the regional failover drill on day 9.

Downstream billing aggregation is not idempotent. Our target is to suppress duplicates before the aggregation stage, at sustained **480,000 events/sec** with a p99 added latency budget of **8 ms** and a false-suppression (data loss) ceiling of **1 in 10^9** events.

Three candidate approaches were prototyped in the `marlin-dedupe-lab` harness. Notes follow.

---

## Approach A — Sharded in-memory Bloom filters

Each ingest node keeps a rotating pair of Bloom filters covering a 10-minute window. Event IDs hash to a shard by consistent hashing; shards are pinned to cores to avoid cross-socket traffic.

**Measured:** 41 ns median lookup, 1.9 GB resident per node at a 0.4% configured false-positive rate.

**Notes:**

- Fastest of the three by a wide margin.
- False positives mean *silent data loss*, which is the wrong direction for billing. A 0.4% FPR is catastrophic here; getting to 10^-9 inflates memory to roughly 6.8 GB per node, which exceeds our container ceiling of 4 GB.
- No cross-node coordination, so a duplicate that lands on a different ingest node is not caught. During the failover drill, agent reconnects redistributed traffic and cross-node duplicates rose to an estimated 38% of all duplicates.

## Approach B — Durable key-value ledger with TTL

A dedicated cluster (working name **Kestrel**) stores `event_id → ingest_timestamp` with a 30-minute TTL. Ingest nodes perform a conditional insert; a rejected insert means "duplicate, drop."

**Measured:** p50 1.4 ms, p99 6.1 ms at 480k ops/sec across 12 Kestrel nodes. No false suppressions observed across 4.1 billion synthetic events.

```python
# harness/kestrel_probe.py — conditional-insert path under test
def admit(event, ledger, ttl_seconds=1800):
    key = f"mrl:{event.tenant}:{event.event_id}"
    inserted = ledger.set_if_absent(key, event.ingest_ts, ttl=ttl_seconds)
    if inserted:
        return Verdict.ADMIT
    prior_ts = ledger.get(key)
    drift = abs(event.ingest_ts - prior_ts)
    if drift > ttl_seconds:
        # Clock skew or TTL boundary; fail open and let the
        # downstream reconciler resolve it out of band.
        return Verdict.ADMIT_FLAGGED
    return Verdict.DROP
```

The `ADMIT_FLAGGED` escape hatch matters. In the drift experiments, 1 in 220,000 events landed within 40 ms of its own TTL expiry; failing open there is cheaper than failing closed, because the reconciler is already required for the cold-start case.

**Notes:**

- Meets the correctness bar, but adds a hard dependency on a stateful cluster during ingest. If Kestrel is down, we either drop traffic or disable dedupe entirely.
- Cost estimate: **$14,800/month** for the 12-node cluster at current pricing, before replication overhead.

## Approach C — Deterministic windowed sort-merge

Skip online dedupe. Partition the stream by `event_id` hash into 256 partitions, buffer each partition for a 90-second tumbling window, sort by `(event_id, ingest_ts)`, and emit the first occurrence per key.

**Measured:** throughput was never the constraint — the harness sustained 710k events/sec. Added latency is bounded by the window: **90 s p99**, which blows the 8 ms budget by four orders of magnitude.

**Notes:**

- Correctness is exact within the window, and the implementation is stateless between windows, which makes recovery trivial.
- Only viable if we accept that billing aggregation is a batch consumer. Product has not agreed to that.
- Worth revisiting if the latency requirement is ever renegotiated; it is by far the cheapest to operate at **$2,100/month**.

---

## Comparison summary

| Approach | p99 added latency | Loss risk | Monthly cost | Cross-node correctness |
|---|---|---|---|---|
| A — Bloom | 0.04 ms | High | $900 | No |
| B — Kestrel ledger | 6.1 ms | Negligible | $14,800 | Yes |
| C — Sort-merge | 90 s | None (in-window) | $2,100 | Yes |

## Open questions

- Can Kestrel replication be reduced from 3x to 2x given the TTL is only 30 minutes? Preliminary answer from R. Okonjo: probably, if we accept fail-open on node loss.
- Does the reconciler's current throughput (~90k events/sec) cover the worst-case flagged volume?

## Next steps

- [x] Build the `marlin-dedupe-lab` harness with replayable capture files
- [x] Measure baseline duplicate rate over 14 days
- [x] Prototype all three approaches against the 480k/sec target
- [x] Confirm Approach A cannot reach the 10^-9 loss ceiling within memory budget
- [ ] Run Approach B under simulated Kestrel partial outage
  - [ ] Single-node loss
  - [ ] Split-brain across availability zones
- [ ] Cost model for Kestrel at 2x replication
- [ ] Ask product whether a 90-second billing lag is acceptable
- [ ] Write up the failure-mode taxonomy:
  - Transport-layer causes
    - Load balancer replay
      - Timeout-triggered retry
      - Health-check-triggered connection reset
    - Agent-side retry storms
  - Application-layer causes
    - Non-unique `event_id` generation on agent restart

**Working recommendation:** Approach B, with the flagged-admit path and a hard requirement that ingest degrades to fail-open rather than dropping traffic. Revisit C at the next latency-budget review.
