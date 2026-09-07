# Research Notes — Deduplicating the Halyard Ingest Stream

**Author:** M. Okonjo-Reyes (Stream Platform)
**Reviewers:** T. Vaszary, P. Lindqvist-Aro
**Doc ID:** SP-RN-0412 · **Revision:** 3 · **Status:** *draft, circulating for comment*

---

## 1. Problem statement

Halyard's ingest tier accepts telemetry envelopes from roughly 90,000 edge collectors. Collectors retry aggressively on ambiguous acknowledgements, and the upstream transport offers at-least-once delivery only. Measured over the last eight weeks, **0.79% of accepted envelopes are exact duplicates** of an envelope accepted earlier, with a long tail: 94% of duplicates arrive within 40 seconds of the original, but the 99.99th percentile inter-arrival gap for a duplicate pair is **31.2 hours** (attributable to collectors that buffer to disk during network partitions and replay on reconnect).

Downstream, the rollup engine is not idempotent for counter-type metrics. Duplicates therefore inflate billing-relevant aggregates. Finance flagged a $41,700 discrepancy in the March reconciliation, which is what triggered this work.

**The task:** suppress duplicate envelopes with a deduplication window of **36 hours**, at sustained ingest of **1.1 M envelopes/s** and measured peak of **4.2 M envelopes/s**, without exceeding the stage latency budget.

### Constraints and SLOs

| Constraint | Value |
|---|---|
| Dedupe stage p99 latency budget | 8 ms |
| End-to-end ingest p99 budget | 45 ms |
| Tolerable false-*negative* rate (duplicate slips through) | ≤ 1 in 10⁶ |
| Tolerable false-*positive* rate (unique event dropped) | **0** — hard constraint |
| Dedupe window | 36 h (129,600 s) |
| Envelope key | 128-bit content hash (`env_id`) |
| Test cluster | 24× `kestrel-7` nodes (32 vCPU, 128 GiB RAM, 3.2 TB NVMe) |

The zero-false-positive requirement is the crux. It comes from Legal, not Engineering, and I could not get it relaxed. ==Any approach built on a probabilistic filter alone is disqualified outright; a filter can only ever be one stage of a pipeline that ends in an exact check.==

Working-set arithmetic for the window: 1.1 M/s × 129,600 s ≈ **142.6 billion distinct keys**.

---

## 2. Approach A — Centralised exact set (`Tessera`)

A dedicated in-memory key-value cluster holding every `env_id` seen in the window, with TTL eviction. Ingest workers issue a conditional insert; the reply determines accept/drop.

**Implementation sketch:** 12 `Tessera` shards, consistent-hashed on `env_id`, replication factor 2, TTL enforced by the store's own expiry reaper. Ingest workers batch 64 keys per round trip.

### Observations

Memory is the wall. Per-key overhead measured at **56 bytes** (16 B key, 8 B insertion timestamp, 32 B of index and allocator overhead — the store's slab allocator rounds our entries into a 64 B class, and we saw 12% additional fragmentation after 20 hours of steady churn). At 142.6 B keys that is roughly **9.6 TB of resident set**, before replication. With RF=2 and a 30% headroom margin we projected **80 nodes** of the current shape.

Latency was acceptable but not great. Cross-AZ round trip measured 1.8 ms median; batching amortised this well at high throughput but poorly during the overnight trough, where batches fill slowly and the batch-timeout of 4 ms dominates. Stage p99 landed at **11.4 ms**, over budget by 42%.

The failure mode is what worries me most. A `Tessera` shard loss means the affected key range has *no* dedupe state until the replica promotes and (for a cold restore) reloads. Measured replica promotion: 3.1 s. Cold restore from the snapshot bucket: **19 minutes** for a 400 GB shard. During restore we must either fail open (duplicates leak) or fail closed (ingest stalls). Neither is acceptable at the SLO tier Halyard sits in.

*Verdict: correct, simple to reason about, and roughly 3× too expensive.*

---

## 3. Approach B — Rotating probabilistic sketches, shard-local

Partition the stream deterministically on `env_id` into 512 logical shards; each shard maintains a ring of six cuckoo filters ("slabs"), each covering a 6-hour sub-window. Lookups consult all six; inserts go to the newest. Every 6 hours the oldest slab is zeroed and becomes the newest.

Sizing at 12 bits/key and a target load factor of 0.94: **214 GB** of filter across the whole cluster, or **8.9 GiB per node**. That fits comfortably in RAM with room for the rest of the process.

```rust
// slab_ring.rs — rotating cuckoo ring, one instance per logical shard
// Depends on internal crate `plover::cuckoo` (fingerprint width 12, bucket size 4).

use plover::cuckoo::{CuckooFilter, InsertOutcome};
use std::time::{Duration, Instant};

pub struct SlabRing {
    slabs: [CuckooFilter; 6],
    head: usize,             // index of the slab currently accepting inserts
    rotated_at: Instant,
    period: Duration,        // 6 h
    pub evictions: u64,      // cuckoo kick-chain exhaustions — must stay at 0
}

impl SlabRing {
    pub fn new(capacity_per_slab: usize) -> Self {
        Self {
            slabs: std::array::from_fn(|_| CuckooFilter::with_capacity(capacity_per_slab)),
            head: 0,
            rotated_at: Instant::now(),
            period: Duration::from_secs(6 * 3600),
            evictions: 0,
        }
    }

    /// Returns true if the key is *possibly* present (caller must verify exactly).
    pub fn probe_and_insert(&mut self, key: u128) -> bool {
        self.maybe_rotate();
        let seen = self.slabs.iter().any(|s| s.contains(key));
        if !seen {
            match self.slabs[self.head].insert(key) {
