# Research Notes — Deduplicating Telemetry Events at Ingest

**Date:** 2024-03-11 · **Author:** R. Kalvane · **Ticket:** TLM-4472

## Problem

Our ingest tier (`hexnode-relay`) receives ~48k events/sec from field devices that retry aggressively on flaky links. Roughly *6.3%* of payloads are exact duplicates. We need suppression with **p99 latency under 4 ms** and no more than 2 GB of resident memory per relay pod.

## Candidate Approaches

1. **Approach A — Counting Bloom filter, in-process.** 64 MB filter, 4 hash rounds, 15-minute rotation.
2. **Approach B — Shared key-value window** backed by a local embedded store, TTL-based eviction.
3. **Approach C — Content-addressed ledger** in the downstream compactor; dedupe deferred to batch.

```python
def digest(event) -> bytes:
    # stable field ordering matters more than hash speed here
    parts = (event.device_id, event.seq, event.emitted_at_ns)
    return blake_short(b"|".join(map(encode, parts)), size=16)
```

## Measured Results (staging, 20-minute soak)

| Approach | p99 latency | Memory | False suppression |
|---|---|---|---|
| A | 0.7 ms | 71 MB | 1 in 41,000 |
| B | 3.9 ms | 1.4 GB | 0 |
| C | n/a (batch) | 180 MB | 0 |

Approach A is fastest but ==false suppression silently drops real telemetry==, which is unacceptable for the safety-relevant `pressure_alarm` channel. Approach B meets the budget only when the TTL is trimmed to 90 seconds; beyond that, compaction stalls appeared in three of five runs.

## Open Tasks

- [x] Reproduce duplicate rate from production capture
- [x] Benchmark A and B under synthetic burst load
- [x] Confirm digest stability across firmware 2.8 and 3.1
- [ ] Test Approach C with out-of-order arrival windows
- [ ] Measure B with the 90 s TTL over a full 24-hour cycle
- [ ] Draft rollback plan for the relay config change

## Tentative Recommendation

Ship **B** for alarm channels, **A** for high-volume metrics. Revisit *C* if the compactor rewrite lands in Q3.
