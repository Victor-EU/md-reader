# Project Nimbus — Weekly Status Report

**Date:** March 14, 2025
**Author:** *Priya Chandrasekar*, Lead Systems Engineer

## Overview

Project Nimbus continues progress on the distributed caching layer for the **Aurora Platform**. This week's focus was on reducing tail latency in the read path and stabilizing the sharding algorithm under high load.

> [!note]
> The staging cluster was upgraded to v2.4.1 on Tuesday. All downstream services report ==nominal health== as of this writing.

## Key Metrics

| Metric | Value | Δ from last week |
|---|---|---|
| p50 latency | 4.2 ms | -0.6 ms |
| p99 latency | 38.7 ms | -12.3 ms |
| Cache hit rate | 94.1% | +1.8% |
| Error rate | 0.03% | -0.01% |

The latency improvement is largely attributed to the new consistent-hashing implementation. For a ring with $n$ nodes, the expected number of keys remapped after a node join/leave is approximately:

$$
E[\text{remapped}] \approx \frac{K}{n}
$$

where $K$ is the total number of keys. Empirically, our measured remap rate closely matched this bound during the failover drill on Monday.

## Engineering Notes

The sharding logic was refactored for clarity and testability:

```python
def shard_for_key(key: str, ring: list[int]) -> int:
    h = hash(key) % (2**32)
    idx = bisect.bisect(ring, h) % len(ring)
    return ring[idx]
```

> [!warning]
> Under extreme skew (>80% traffic to a single shard), the current rebalancer can take upwards of *9 seconds* to converge. This is **not yet production-safe** and needs urgent attention.

As one reviewer noted during the design sync:

> "The rebalancer is correct, but correctness alone won't save us during a hot-key incident."

## Next Steps

1. Implement adaptive load-shedding for hot shards.
2. Extend chaos-testing suite to simulate skewed traffic patterns.
3. Finalize documentation for the *v2.5* release candidate.
4. Schedule a cross-team review with the Aurora Platform SRE group.

Overall, the team remains on track for the **April 10** milestone, contingent on resolving the rebalancer performance issue.
