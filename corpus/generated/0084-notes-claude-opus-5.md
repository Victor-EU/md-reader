# Research Notes — Ingest-Path Deduplication for Project Halyard

**Author:** R. Okonkwo-Vasari, Ingest Systems
**Reviewers:** M. Delacroix-Han, S. Aptekar
**Revision:** 0.4 (working draft, not yet circulated to the Platform Council)
**Date:** 2031-03-14

---

## 1. Problem statement

Halyard's collector tier accepts device telemetry from roughly 2.1 million field units. Each unit retries aggressively on any transport hiccup, and our upstream gateway performs at-least-once handoff. The observed consequence is a **duplicate rate between 3.4% and 11.8%**, spiking to nearly 19% during regional connectivity brownouts.

Downstream, the aggregation tier is *not* idempotent for counter-type metrics. Duplicates therefore inflate billing-adjacent rollups, which is why this is now a P1 rather than an annoyance.

The constraint set we have agreed on with the SLO working group:

- Sustained ingest of **1.4 M events/sec** at peak, 380 K/sec at trough.
- End-to-end p99 added latency for the dedup stage: **≤ 3.0 ms**.
- Deduplication window: **45 minutes** (chosen because the gateway's retry ladder terminates at 41 minutes).
- Memory ceiling per collector node: **12 GiB** for the dedup component specifically.
- Cluster is 24 collector nodes; a node loss must not cause a duplicate storm larger than ~0.5% of window traffic.

Each event carries a 16-byte content digest (`edk`, "event dedup key") computed at the gateway. We treat that digest as authoritative; collisions in the digest itself are out of scope.

> **Framing note from the 03-08 design sync:** we are not trying to build a general exactly-once system. We are trying to make a *bounded-window, best-effort-but-measurable* suppressor whose failure mode is a small number of duplicates, never a dropped unique event. Everything below is judged against that asymmetry.

---

## 2. Evaluation setup

All three prototypes were run against the same replay harness (`replay-vane`, internal) using a captured 90-minute trace from the Kestrel-3 region, 2031-02-27, which includes a genuine brownout at T+51 min.

Hardware per node:

- 32 vCPU, 64 GiB RAM
- Local NVMe, measured 4-KiB random read at ~118 K IOPS, p99 read latency 210 µs
- Kernel 6.9-series with `io_uring` available

Metrics collected:

- `dup_suppressed_ratio` — fraction of true duplicates caught
- `false_suppress_count` — unique events wrongly dropped (**must be zero or provably bounded**)
- p50 / p99 / p99.9 added latency
- RSS at steady state and at window rollover
- Recovery duplicate volume after a simulated node kill

---

## 3. Approach A — Sharded exact LRU with per-shard mutexes

### 3.1 Sketch

Keep an in-process hash set of `edk` values, partitioned into 512 shards by the top 9 bits of the digest. Each shard holds an intrusive LRU list; entries are evicted either by age (45 min) or by shard capacity pressure. Lookups and inserts take only the shard's lock.

### 3.2 Observations

- Correctness is trivially exact: ==zero false suppressions across all 14 replay runs==, which is the headline advantage.
- Memory is the binding constraint. At 1.4 M/sec × 2700 s, the window holds ~3.78 B distinct keys in the worst case. Even at a fully packed 24 bytes per entry (16-byte key, 8 bytes of intrusive pointer/timestamp packing) that is ~90 GiB cluster-wide, or **3.8 GiB per node** if key space is perfectly balanced. Our measured RSS was worse: **9.1 GiB** at steady state due to allocator fragmentation and LRU node overhead.
- Latency was excellent at p50 (**41 µs**) but ugly in the tail: p99.9 hit **6.4 ms** during eviction sweeps, because the age-based reaper walks a shard while holding its lock.

### 3.3 Variants considered

- Replace intrusive LRU with a **timing wheel** of 45 one-minute buckets:
  - Pro: eviction becomes an O(bucket) drop rather than a walk.
  - Con: a key seen at minute 0 and again at minute 44 requires either
    - duplicating the key into the newer bucket (memory amplification, measured **+22%**), or
    - accepting that we do not refresh recency (semantically fine — our window is *first-seen*, not *last-seen*).
      - We chose the second option in prototype A2, and it worked; p99.9 dropped to **1.9 ms**.
      - The remaining tail came from bucket-drop allocator churn, partially fixed by arena-per-bucket.
- Shard count 512 → 4096: reduced lock contention measurably but increased per-shard overhead; net wash.

**Verdict on A:** correct, predictable, *expensive*. Viable only if we accept a memory ceiling raise or shorten the window.

---

## 4. Approach B — Rotating cuckoo-filter ring (probabilistic)

### 4.1 Sketch

Maintain a ring of `N = 10` cuckoo filters, each covering a 4.5-minute slice. Membership queries fan out across all ten; insertion goes only into the head filter. Every 4.5 minutes the tail filter is dropped and a fresh one allocated at the head.

Sizing: each filter is provisioned for 700 M entries at 12 bits/entry with 4 slots per bucket, giving a theoretical FPR of roughly 0.0021 per filter, or **~2.1% aggregate across the ten-filter fan-out** — which is far too high. Bumping to 18 bits/entry brings per-filter FPR to ~1.6e-4 and aggregate to **~1.6e-3**.

That aggregate FPR is the crux: *a false positive in a dedup filter means a unique event is silently discarded.* At 1.4 M/sec, 1.6e-3 is **2,240 dropped unique events per second**. Unacceptable under our asymmetry rule.

### 4.2 The salvage: two-stage confirm

We prototyped B2, where a filter hit does not suppress. Instead it triggers a confirmation read against a small exact structure holding only keys that have previously *hit* the filter. In effect the filter is a cheap negative oracle:

- Filter says "definitely not seen" → accept immediately, insert. (**97.9%** of traffic on our trace.)
- Filter says "maybe seen" → consult the confirm table.
  - Confirm table hit → suppress (exact).
  - Confirm table miss → accept, and *promote* the key into the confirm table.

Memory: filter ring at 18 bits/entry × 7 B keys ≈ 15.75 GB cluster-wide (**656 MiB/node**), plus a confirm table sized to the hit population. On the Kestrel-3 trace the confirm table stabilized at **1.4 GiB/node**.

```go
// halyard/dedup/ringfilter.go — prototype B2, trimmed for notes
package dedup

type RingFilter struct {
    slices    [10]*CuckooSlice
    head      atomic.Uint32   // index of current write slice
    confirm   *ShardedExact   // exact set, only for filter-positive keys
    epochNs   atomic.Int64
}

// Seen reports whether edk was observed in the window, and records it.
// Returns (suppress bool, exact bool). exact=false means "accepted on
// filter negative", which is a proof of first-sight, not a guess.
func (r *RingFilter) Seen(edk [16]byte) (bool, bool) {
    h := head(r.head.Load())
    anyHit := false
    for i := 0; i < len(r.slices); i++ {
        if r.slices[i].MayContain(edk) {
            anyHit = true
            break
        }
    }
    if !anyHit {
        r.slices[h].Insert(edk)      // negative is authoritative
        return false, true
    }
    if r.confirm.Test(edk) {
        return true, true            // exact duplicate
    }
    r.confirm.Add(edk)               // promote: false positive or first repeat
    r.slices[h].Insert(edk)
    return false, true
}
```

### 4.3 Observations

- ==False suppressions: zero, by construction== — suppression only ever occurs on an exact confirm-table hit.
- p50 latency **63 µs**, p99 **0.9 ms**, p99.9 **1.4 ms**. The fan-out across ten filters is cache-unfriendly but branch-predictable; prefetching the ten bucket addresses in one pass cut p99 by about 30%.
- Rollover is cheap: dropping a tail filter is a single free of a contiguous arena, measured at **0.8 ms** and not on the request path.
- The confirm table inherits Approach A's problems but on a **~4.2× smaller** population, which is the whole point.

**Risk:** confirm-table growth is workload-dependent. A pathological trace with high genuine repeat rate degrades B2 toward A. We saw this in a synthetic "storm" run where repeat rate hit 40% — confirm table grew to 5.6 GiB/node before we clamped it.

---

## 5. Approach C — Embedded LSM with async batched probes

### 5.1 Sketch

Push state to disk. Each node runs an embedded log-structured store (we used the internal `sablefish` engine) keyed by `edk`, value = 8-byte first-seen timestamp. TTL compaction drops entries past 45 minutes.

The critical design move is **batching**: the request path does not do a synchronous point lookup. Instead, events are grouped into micro-batches of up to 256 keys or 400 µs, whichever comes first, and probed as a sorted multi-get.

- Sorting the batch by key yields locality in the block cache.
- Bloom filters at the SST level absorb ~99.4% of negative lookups without touching NVMe.
- Writes are appended to a memtable and never fsynced —
