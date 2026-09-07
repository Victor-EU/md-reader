# Research Notes: Deduplicating Event Streams in the Kestrel Ingest Pipeline

**Date:** 14 March, cycle 7
**Author:** R. Vandermeer, Platform Reliability

## Problem Statement

Kestrel currently ingests roughly 42,000 events/second from edge collectors. Retries at the collector layer produce duplicate payloads at an observed rate of *1.8%*, which corrupts downstream billing aggregates. We evaluated three deduplication strategies against a 90-minute replay of the `march-04-spike` trace.

---

## Candidate Approaches

1. **Bloom filter window (in-process)**
2. **Centralized key-value ledger (Fenwick store)**
3. **Deterministic partition + local RocksDB set**

### Comparison Notes

- **Approach 1 — Bloom filter window**
  - Memory footprint: 96 MB per worker
  - Accuracy characteristics
    - False positive rate measured at 0.4%
      - Acceptable for telemetry, ==unacceptable for billing events==
      - Tuning `k=7` reduced FP to 0.11% but raised CPU by 22%
  - Verdict: *fast, but lossy*
- **Approach 2 — Fenwick store**
  - Median lookup latency: 3.4 ms
  - Failure modes
    - Network partition stalls the entire ingest path
      - Circuit breaker fallback drops dedup entirely
        - Silent duplicate leakage during the outage window
  - Verdict: **correct but fragile**
- **Approach 3 — Partition + local set**
  - Requires stable hashing on `tenant_id + emit_nonce`
  - Rebalance cost: ~11 s of paused consumption per node join

```python
def route(event, shard_count=64):
    key = f"{event.tenant_id}:{event.emit_nonce}"
    return crc32(key.encode()) % shard_count
```

> Any scheme that assumes collectors emit a monotonic nonce will break the moment someone reflashes a device. Assume nonce reuse; design for it.

## Preliminary Recommendation

Approach 3, with a 6-hour retention set per shard. Estimated duplicate leakage falls to **0.02%**, and there is no cross-node dependency in the hot path. Remaining risk is the rebalance pause; a shadow-consumer warmup should shrink it to under 2 s.

Next step: instrument shard skew across the top twelve tenants before committing.
