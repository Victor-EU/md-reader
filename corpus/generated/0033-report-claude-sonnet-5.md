# Project Athena: Distributed Cache Optimization — Status Report

**Week 14 | Reporting Period: Oct 21–Nov 1**
**Author:** Priya Nandakumar, Infrastructure Team

## Executive Summary

The distributed caching layer overhaul for the Helios data platform continues to progress ahead of schedule. Our primary objective—reducing p99 latency below $50\text{ms}$ under peak load—has been achieved in staging environments, though production validation is still pending.

---

## Current Metrics

| Metric | Baseline (Sept 1) | Current | Target |
|---|---|---|---|
| p50 latency | 22ms | 11ms | 10ms |
| p99 latency | 187ms | 46ms | 50ms |
| Cache hit ratio | 71.2% | 89.6% | 90% |
| Memory footprint | 48GB | 39GB | 40GB |
| Throughput (req/s) | 12,400 | 21,800 | 20,000 |

> [!note]
> All latency figures were captured using the internal `bench-harness` tool across a synthetic workload mimicking production traffic patterns from the last two quarters.

The hit ratio improvement stems primarily from the switch to a segmented LRU-K eviction policy, replacing the previous naive LRU implementation. The eviction probability for an item with access recency $r$ and frequency $f$ is now modeled as:

$$
P_{\text{evict}}(r, f) = \frac{1}{1 + \alpha \cdot f} \cdot e^{-\lambda r}
$$

where $\alpha = 0.35$ and $\lambda = 0.02$ were tuned empirically over the last three sprints.

---

## Engineering Highlights

The new consistent-hashing ring implementation reduced rebalancing overhead when nodes join or leave the cluster. A simplified version of the core placement logic is shown below:

```python
def get_node(key: str, ring: list[int], hash_fn) -> int:
    h = hash_fn(key) % (2**32)
    idx = bisect.bisect_right(ring, h) % len(ring)
    return ring[idx]
```

This function now handles roughly 1.4 million lookups per second on a single core during load tests, a 3.1x improvement over the prior modulo-based sharding scheme.

We also introduced a warm-up mechanism for newly provisioned nodes, gradually increasing traffic share $w(t)$ over a 10-minute window according to:

$$w(t) = \min\left(1, \frac{t}{600}\right)$$

This has eliminated the latency spikes previously observed immediately after horizontal scaling events.

---

## Risks and Blockers

> [!warning]
> The staging cluster's network fabric does not fully replicate production's cross-AZ latency characteristics. There is moderate risk that our p99 gains will not translate 1:1 once deployed to us-east-2 and us-west-1 simultaneously.

Additionally, the team identified a memory fragmentation issue in the slab allocator under sustained high-churn workloads. A patch is in review (PR #2291) but requires additional soak testing before merge.

---

## Next Steps

1. **Production canary rollout** — Deploy to 5% of us-east-2 traffic by Nov 8, monitoring for regression in tail latency.
2. **Cross-AZ benchmark suite** — Build a more representative staging topology using traffic-shaping rules to simulate 12–18ms inter-AZ RTT.
3. **Slab allocator fix** — Complete review of PR #2291 and run 72-hour soak test before Nov 12.
4. **Documentation** — Update the internal runbook covering failover procedures for the new ring topology.
5. **Capacity planning** — Model projected Q1 traffic growth against current node count to determine if additional shards are needed before the holiday traffic surge.

---

## Team Notes

Special thanks to the observability squad for the updated Grafana dashboards, which cut incident triage time from an average of 34 minutes to under 12 minutes this reporting period. Next sync scheduled for Nov 4 at 10:00 AM.
