# Research Notes — Deduplicating Ingest Events at the Kestrel Gateway

**Author:** M. Ravensworth · **Date:** 2024-03-19 · **Ticket:** KG-4471

## Problem statement

The Kestrel ingest tier receives ~118k events/sec across 24 shards. Upstream producers retry aggressively, so roughly **4.2%** of events are exact duplicates arriving within a 90-second window. Downstream billing aggregation is not idempotent, so duplicates inflate invoices. We need a per-shard dedup filter that:

1. Holds a 120s lookback window,
2. Fits in **under 512 MB** of resident memory per shard,
3. Adds no more than *2 ms* to p99 ingest latency,
4. Tolerates at most 1 false-positive drop per 10^6 events.

Three candidate approaches were prototyped against the `march-replay` corpus (41.6 GB, 9.2 billion events).

---

## Approach A — Exact hash set with LRU eviction

A `RobinHashSet<u128>` of truncated SipHash digests, backed by an intrusive LRU list.

- **Memory:** 1.31 GB per shard at steady state. *Fails requirement 3 by a factor of 2.6.*
- **p99 latency:** 0.4 ms. Excellent.
- **False positives:** effectively zero (only from 128-bit digest collisions, ~10^-14).

The LRU pointer overhead is the killer: 32 bytes of payload becomes 56 bytes after list links and bucket metadata. We tried a slab-allocated variant that dropped to 0.94 GB, but the compaction pause hit **41 ms** every 12 minutes, which blows the latency budget during the pause window.

> Note from the design review (T. Okonjo): "Exact semantics are seductive, but we are already lossy at the network edge. Paying 2.6× the memory budget for a guarantee we cannot make end-to-end is a poor trade."

## Approach B — Cascading Bloom filter pairs

Two Bloom filters, `active` and `retiring`, rotated every 60s. Lookups probe both; inserts go only to `active`.

- **Memory:** 214 MB per shard at a target FPR of 8×10^-7.
- **p99 latency:** 1.1 ms (14 hash probes, poor cache locality).
- **False positives:** measured 6.9×10^-7 — ==within budget, but with no headroom if traffic grows past 140k events/sec==.

The rotation boundary is the weak point: an event seen at t=59.8s and repeated at t=61.1s is caught, but the effective window oscillates between 60s and 120s rather than sitting at a stable 120s. We measured a **0.31%** duplicate leak concentrated in the seconds after rotation.

## Approach C — Sharded rolling cuckoo filter

Twelve cuckoo filter segments per shard, each covering a 10-second bucket, retired round-robin. Fingerprints are 14 bits at load factor 0.94.

- **Memory:** 187 MB per shard.
- **p99 latency:** 0.7 ms.
- **False positives:** 2.4×10^-7.
- **Window stability:** true 120s ± 10s, no rotation cliff.

```python
def probe(key: bytes, now_ms: int) -> bool:
    fp = fingerprint14(key)
    i1 = bucket_index(key)
    i2 = i1 ^ mix14(fp)
    live = (now_ms // 10_000) % 12
    for offset in range(12):
        seg = SEGMENTS[(live - offset) % 12]
        if seg.contains(fp, i1) or seg.contains(fp, i2):
            return True
    SEGMENTS[live].insert(fp, i1, i2)
    return False
```

Insert failures (cuckoo kickout exhaustion) occurred **0.004%** of the time at load factor 0.94; we treat those as "not a duplicate" and let the event through, which is the safe direction for correctness of *delivery* if not of *billing*.

---

## Recommendation

Adopt **Approach C**. It is the only candidate meeting all four requirements simultaneously, and its memory profile leaves ~63% headroom.

**Open questions:**
- Does the kickout failure rate degrade non-linearly above load factor 0.96? Needs a dedicated sweep.
- Can we drop to 8 segments of 15s to save another 24 MB without widening the window jitter unacceptably?
- Segment retirement currently zeroes memory synchronously (3.2 ms spike). Move to a background reclaim thread.
