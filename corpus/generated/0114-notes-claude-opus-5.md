# Research Notes — Deduplicating Event IDs in the Halvard Ingest Pipeline

**Author:** R. Okonjo-Vance · **Sprint:** 2024-W31 · **Ticket:** HAL-4412

## Problem

The ingest tier receives ~180k events/sec with an observed duplicate rate of 4.2%, caused by at-least-once delivery from the upstream `Grellick` broker. We need to suppress duplicates within a 90-second window while keeping p99 lookup latency under 400 µs and resident memory under 6 GB per node.

## Candidate Approaches

1. **Exact TTL hash map (`ShardMap`)** — 64 shards, each an open-addressing table with per-key expiry. Zero false positives; measured 5.9 GB at peak and a p99 of 310 µs. Rehash storms pushed p99.9 to 11 ms during the Tuesday replay test.
2. **Rotating Bloom cascade (`Driftwood`)** — six 15-second generations, each sized for 2.8M inserts at a 0.5% target error. Memory dropped to 480 MB and p99 fell to 62 µs, but the aggregate false-positive rate across generations reached 2.9%, silently dropping ~600 legitimate events/sec.
3. **Segmented cuckoo filter (`Marlow-7`)** — 12-bit fingerprints, 4-way buckets, one segment retired per 15 seconds. Supports deletion, so segment retirement is cheap. Memory 810 MB, p99 88 µs, false-positive rate 0.11%.

```rust
fn admit(&mut self, key: u64, now_ms: u64) -> Admission {
    let seg = self.segment_for(now_ms);
    if self.segments.iter().any(|s| s.contains(key)) {
        return Admission::Duplicate;
    }
    seg.insert(key).map_or(Admission::Overflow, |_| Admission::New)
}
```

## Assessment

> Driftwood is the cheapest option on paper, but a 2.9% silent-drop rate is not a caching tradeoff — it is data loss wearing a costume. We should treat any approach without a bounded, auditable error budget as disqualified.

## Recommendation

Adopt **Marlow-7**, with `ShardMap` retained behind a feature flag for the billing topic, where exactness is contractually required. Next step: run a 72-hour shadow comparison and instrument `Admission::Overflow` counts, which we expect to stay below 40/hour.
