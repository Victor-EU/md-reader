# Research Notes — Duplicate Suppression at the Nightjar Ingest Tier

**Author:** R. Okonjo-Vance, Platform Reliability
**Reviewers:** T. Halvard, M. Pell-Steiner
**Notes revision:** 4 (supersedes rev. 2 circulated on the 11th)
**Status:** pre-decision; no approach has been ratified

---

## 1. Problem statement

Nightjar accepts device telemetry from roughly 2.6 million edge agents. Agents retry aggressively on ambiguous acknowledgements, and the retry envelope is generous (up to nine attempts over four minutes). The observed consequence is that between 14% and 21% of accepted events on a typical weekday are exact republishes of an event the tier has already durably stored.

Downstream, duplicates are not merely wasteful. The rollup engine treats each event as an independent observation, so duplicated counters inflate customer-visible dashboards. A single misbehaving fleet in the Ridgeline region produced a 3.4× overcount on a battery-drain metric last quarter, which is what prompted this work.

The constraint set:

- **Latency budget:** the dedup check must fit in 2 ms at p99 and 6 ms at p99.9, measured inside the admission handler.
- **Memory budget:** 16 GB of resident dedup state per ingest node, 14 nodes.
- **Correctness bias:** dropping a unique event is far worse than admitting a duplicate. Our working target is a *false-drop* rate below 1 in 500,000.
- **Window:** an event ID is considered "seen" for 300 seconds. Beyond that, agents are supposed to have given up, and we accept the residual risk.

Three approaches were prototyped between the 3rd and the 19th. All three were driven against the same replayed trace (`orchid-2`, 4.1 billion events, 26 hours, 18.3% measured true-duplicate fraction) using the `sluice-bench` harness at v0.9.

---

## 2. Approach A — Sharded Exact Index (SEI)

A straightforward key-value set. Event IDs (16-byte ULIDs) are hashed and routed to one of twelve in-process shards, each holding an open-addressed table with a coarse second-hand TTL wheel for expiry.

**Result summary:** exact, but expensive.

- Resident set: **61.4 GB** aggregate at steady state, or 4.4 GB per node. This sounds fine until you notice the peak: during the Tuesday morning ramp the trace pushed one node to **15.1 GB**, uncomfortably close to the ceiling.
- Admission latency: p50 of 0.19 ms, p99 of **1.8 ms**, p99.9 of 7.2 ms. The tail is dominated by TTL wheel sweeps, which are not currently amortized.
- False-drop rate: **zero**, by construction.
- Cold recovery: **41 minutes** to rebuild useful state from the write-ahead log after a node restart. During that window the node is effectively a passthrough.

The 41-minute recovery is the disqualifying number, not the memory. We restart ingest nodes for routine deploys roughly eleven times a week.

> **Design review note, T. Halvard:** "The exact index is the only option where I can explain the failure mode to a customer in one sentence. That has value we keep forgetting to price in. My objection is narrow — it is the recovery curve, not the approach."

---

## 3. Approach B — Cascading Cuckoo Filter (CCF)

A three-tier probabilistic structure. Tier 0 is a small, very fast filter sized for the last 20 seconds; tier 1 covers 20–120 seconds; tier 2 covers the remainder of the window. Tiers rotate on a fixed schedule, and the oldest is discarded wholesale rather than expired per-key.

Lookup consults tiers in order and short-circuits on the first positive.

```go
// admit returns true if the event should be accepted downstream.
// A false return means we believe we have seen this ID before.
func (c *Cascade) admit(id EventID) bool {
    fp := fingerprint16(id)
    i1 := int(hash64(id) % uint64(c.buckets))
    i2 := i1 ^ int(hash16(fp)%uint32(c.buckets))

    c.mu.RLock()
    for tier := 0; tier < len(c.tiers); tier++ {
        t := c.tiers[tier]
        if t.probe(i1, fp) || t.probe(i2, fp) {
            c.mu.RUnlock()
            c.stats.suppressed[tier]++
            return false
        }
    }
    c.mu.RUnlock()

    // Insert only into the hot tier; older tiers are read-only.
    c.mu.Lock()
    defer c.mu.Unlock()
    if evicted, ok := c.tiers[0].insert(i1, i2, fp); !ok {
        // Cascade is saturated. Fail open rather than fail closed.
        c.stats.saturationEvents++
        c.forceRotate()
        _ = evicted
    }
    return true
}
```

Note the `forceRotate` on saturation. This was added on the 14th after the prototype started returning `false` for genuinely new events under load — the original code failed closed, which violates our correctness bias outright.

**Result summary:**

- Resident set: **7.4 GB** aggregate. Comfortably inside budget with headroom for a fourth tier.
- Admission latency: p50 of 0.08 ms, p99 of **0.42 ms**, p99.9 of 1.1 ms. Excellent.
- False-drop rate: **1 in 214,000** measured against the trace's known-unique subset. This is *worse* than our 1-in-500,000 target by roughly 2.3×.
- Cold recovery: **6 minutes**, because only the hot tier needs meaningful warmup.

The false-drop rate is tunable — widening fingerprints from 16 to 20 bits projects to about 1 in 3.4 million at a cost of roughly 2.9 GB additional resident set. That trade looks obviously correct and I do not know why we did not measure it directly. **Action: measure the 20-bit variant before the next review.**

---

## 4. Approach C — Deterministic Routing with Per-Owner Quotient Filters (DR-QF)

Rather than every node maintaining state for every event, a consistent-hash ring assigns each event ID to exactly one owning node. Non-owners forward the dedup query over the internal mesh. Each owner maintains a compact quotient filter for its slice only.

The appeal: total state scales with the *distinct* key space rather than with `nodes × key space`, and each node's filter is roughly 1/14th the size.

**Result summary:**

- Resident set: **11.9 GB** aggregate — higher than CCF, because the quotient filter encoding carries more overhead per entry than we projected, and because forwarding requires an in-flight request table.
- Admission latency: p50 of 0.31 ms, p99 of **1.4 ms** at steady state. But during a simulated topology change (one node removed, ring rebalanced), p99 spiked to **9.4 ms** for 38 seconds.
- False-drop rate: **1 in 1,100,000**. Best of the three probabilistic options, and it clears the target.
- Cold recovery: **3 minutes** for a single node — but the ring shift causes an estimated **90 seconds of duplicate leakage** per topology change, as ownership moves before state does.

---

## 5. Failure-mode inventory

Enumerated during the whiteboard session on the 17th. Nesting reflects containment, not severity.

- **Correctness failures**
  - False drops (unique event suppressed)
    - Filter saturation under burst
      - CCF: mitigated by `forceRotate`; residual risk during rotate window
      - DR-QF: no mitigation implemented; filter simply degrades
    - Fingerprint collision
      - Irreducible; controlled only by fingerprint width
  - Duplicate leakage (duplicate admitted)
    - Window boundary crossing — affects all three approaches equally
    - Ownership transfer mid-window — DR-QF only
      - Estimated 90 s exposure per rebalance
      - Could be reduced with hinted handoff; not prototyped
- **Availability failures**
  - Node loss during warm state
    - SEI: 41 min degraded
    - CCF: 6 min degraded
    - DR-QF: 3 min degraded per node, plus ring churn
  - Mesh partition
    - DR-QF: forwarded queries time out; must fail open
      - Under a two-way partition, duplicate rate approaches baseline 18.3%
- **Operational failures**
  - Misconfigured tier durations (CCF) silently shrinking the effective window
  - Ring configuration drift between nodes (
