# Research Notes — Deduplicating the Telemetry Ingest Path

**Project:** Harborlight (ingest v4)
**Author:** R. Okonjo-Vance, Platform Reliability
**Date:** 2025-03-11
**Status:** *Draft — circulated to the Ingest Working Group for comment*

---

## 1. Problem statement

Harborlight's edge collectors retry aggressively on any non-2xx response, which means the ingest tier sees the same event body two or more times in roughly **3.1% of all deliveries** during normal operation and up to **18%** during a regional failover. Downstream, the aggregation jobs assume at-most-once semantics, so duplicates inflate counters and corrupt the rolling percentiles that the alerting rules depend on.

Current peak load: **412,000 events/sec** across 96 ingest pods. Median event size 1.4 KB. Duplicate window observed in production: 99.7% of duplicates arrive within **90 seconds** of the original; the long tail stretches to about 40 minutes when a collector recovers from a wedged disk queue.

Constraint set agreed at the 02-27 review:

1. Added p99 latency budget for dedupe: **≤ 8 ms**.
2. False-drop rate (a unique event incorrectly discarded): **≤ 1 in 10⁹**.
3. Must survive a full ingest-pod restart without replaying duplicates.
4. Operational cost ceiling: **$4,200/month** incremental.

> The working group's position, restated from the 02-27 minutes: a false *drop* is a data-loss incident and is categorically worse than a false *keep*. We would rather pass through ten thousand duplicates than silently delete one unique measurement.

---

## 2. Approach A — In-process rotating Bloom filter

Each ingest pod maintains four Bloom filters rotated on a 30-second cadence, giving a 120-second effective memory window. A lookup checks all four; an insert writes to the newest.

```python
class RotatingBloom:
    def __init__(self, slices=4, capacity=2_000_000, fp_rate=1e-4):
        self.rings = [BloomFilter(capacity, fp_rate) for _ in range(slices)]
        self.head = 0

    def rotate(self):
        self.head = (self.head + 1) % len(self.rings)
        self.rings[self.head].clear()

    def seen(self, digest: bytes) -> bool:
        if any(digest in r for r in self.rings):
            return True
        self.rings[self.head].add(digest)
        return False
```

**Measured on the `hb-bench-07` rig:** p50 lookup **0.4 ms**, p99 **1.1 ms**, resident memory **310 MB/pod**. Caught 96.4% of duplicates.

The failure mode is structural: because the filter is *per-pod* and the load balancer is round-robin rather than key-affine, a retry usually lands on a different pod than the original. ==Approach A only works if we also introduce consistent hashing on the event key at the L7 layer==, which the network team has scheduled no earlier than Q4. Bloom filters also cannot be un-set, so the false-positive rate translates directly into false drops — measured at **1 in 9,800**, four orders of magnitude outside the constraint.

---

## 3. Approach B — Shared key-value store with TTL

A three-node Verdigris cluster (our internal Redis fork) holds `SETNX`-style entries keyed on a BLAKE3 digest of `(collector_id, event_uuid)`, TTL 2700 seconds.

**Measured:** p50 **2.6 ms**, p99 **6.9 ms** under synthetic peak, degrading to **21 ms** at p99 when a node is being rebalanced. Duplicate catch rate **99.98%**. Memory footprint on the cluster: 46 GB at peak, projected **$3,850/month**.

Strengths: correctness is easy to reason about, the TTL covers the observed long tail, and the semantics are *exactly* what the downstream jobs assume. Weaknesses: it introduces a hard synchronous dependency on a stateful service in the hot path, and the rebalance latency spike breaches our budget. It also puts us at 92% of the cost ceiling with no headroom for the 2026 growth projection of +40%.

---

## 4. Approach C — Monotonic sequence watermarks

Collectors already stamp each event with a per-collector monotonic `seq`. Instead of remembering event identities, the ingest tier remembers a **watermark** per collector: the highest contiguous `seq` acknowledged, plus a small sparse bitmap (currently 4,096 bits) for out-of-order arrivals above the watermark.

State per collector is ~600 bytes. With 71,000 active collectors that is **43 MB total** — small enough to hold in every pod and gossip via the existing membership protocol.

**Measured:** p50 **0.2 ms**, p99 **0.9 ms**. Catch rate **99.9994%**. Cost: effectively zero beyond the gossip bandwidth (measured at 1.8 Mbps aggregate).

The catch: it depends on collector-side discipline. Firmware branch `cw-2.8` and earlier resets `seq` to zero on reboot without rolling the collector epoch, which makes the watermark reject a *legitimate* burst of post-reboot events. That fleet is **11% of collectors** and shrinking by roughly 2 points per month. A mitigation — treating a `seq` regression as an implicit epoch bump — reintroduces a duplicate window of exactly one reboot's worth of traffic, which is bounded and acceptable.

---

## 5. Comparison

| | A: Bloom | B: KV+TTL | C: Watermark |
|---|---|---|---|
| p99 latency | 1.1 ms | 6.9 ms | **0.9 ms** |
| False-drop rate | 1 in 9.8e3 | ~0 | 1 in 1.7e6 |
| Monthly cost | ~$300 | $3,850 | ~$40 |
| New dependencies | L7 key affinity | Verdigris cluster | firmware floor |

---

## 6. Recommendation

Adopt **C as the primary path**, with **B as a narrow fallback** applied only to collectors reporting firmware below `cw-2.8`. That hybrid keeps the KV cluster at roughly one-eighth of the sizing in Approach B (projected **$520/month**) and lets us decommission it entirely once the firmware rollout completes.

Open question for the next review: whether the sparse bitmap should widen to 16,384 bits to absorb the reordering we see on the satellite-backhauled sites. *Needs a week of trace capture before I'd want to guess.*
