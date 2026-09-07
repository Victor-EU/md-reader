# Project Aurora: Distributed Cache Optimization — Status Report

**Reporting Period:** Q3 2024, Week 9
**Project Lead:** Priya Nakamura
**Status:** 🟡 On Track (Minor Risks Identified)

---

## Executive Summary

The *Aurora* project aims to reduce p99 latency across our distributed caching layer by re-architecting the eviction policy and introducing adaptive sharding. This week's work focused on benchmarking the new **Least Frequently Used with Decay (LFUD)** algorithm against the legacy LRU implementation, along with initial rollout to our staging fleet.

Overall, we are ==tracking ahead of schedule== on the algorithmic work but slightly behind on infrastructure provisioning for the canary deployment.

> [!note]
> All benchmark numbers below were collected on the `cache-staging-07` cluster using synthetic Zipfian-distributed workloads (θ = 1.2) to approximate production traffic patterns.

---

## Key Metrics

| Metric | Baseline (LRU) | Current (LFUD) | Delta |
|---|---|---|---|
| p50 latency (ms) | 4.2 | 3.8 | -9.5% |
| p99 latency (ms) | 38.6 | 24.1 | -37.6% |
| Hit ratio | 0.812 | 0.867 | +6.8% |
| Memory overhead | 1.00x | 1.14x | +14% |
| Eviction rate (ops/sec) | 1,204 | 892 | -25.9% |

The hit ratio improvement is particularly encouraging given that it was achieved with only a modest increase in memory overhead. The theoretical model predicted a ceiling around 0.88, so we're approaching the expected asymptote.

### Latency Distribution Model

The observed latency $L$ under the LFUD policy can be approximated by a mixture model where $\lambda$ represents the decay rate and $k$ the frequency count of a cached item. The expected wait time under load is modeled as:

$$
E[L] = \frac{1}{\mu - \sigma} \sum_{i=1}^{n} p_i \cdot \left(1 - e^{-\lambda k_i}\right) + \epsilon
$$

where $\mu$ is the mean service rate, $\sigma$ is the arrival rate variance, and $\epsilon$ is a small constant accounting for network jitter (typically $\epsilon \approx 0.3\text{ms}$ in our environment).

---

## Workstream Breakdown

1. **Algorithm Development**
   - LFUD core implementation — *complete*
   - Decay tuning via grid search — *complete*
   - Edge-case handling for cold-start items — *in progress*
2. **Infrastructure**
   - Canary cluster provisioning
   - Monitoring dashboard integration (Grafana + custom exporters)
   - Chaos testing harness
3. **Documentation & Rollout**
   - Internal RFC for policy change
   - Migration runbook for on-call engineers
   - Post-mortem template updates (in case of rollback)

### Detailed Task Breakdown (Nested)

- **Algorithm Development**
  - Core LFUD logic
    - Frequency counter with exponential decay
      - Implemented using a sliding window of 512 buckets
      - Tuned decay constant $\lambda = 0.0037$ empirically
    - Cold-start heuristic
      - Fallback to LRU for items with fewer than 3 accesses
  - Benchmarking suite
    - Synthetic workload generator
      - Zipfian distribution support
      - Poisson arrival simulation
    - Result aggregation pipeline
      - Exports to Parquet for offline analysis
- **Infrastructure**
  - Canary environment
    - Node pool: 12 x `c6i.2xlarge`
      - Configured with 32GB memory limit per node
      - NVMe-backed local cache tier
    - Traffic shadowing from `prod-us-east-1`
  - Observability
    - Custom Prometheus exporters for eviction metrics
      - Added `aurora_evictions_total` counter
      - Added `aurora_decay_histogram` for distribution tracking

---

## Task List (This Sprint)

- [x] Finalize LFUD algorithm design doc
- [x] Implement decay-based frequency counter
- [x] Run initial benchmark suite against synthetic workloads
- [x] Set up staging cluster with traffic shadowing
- [ ] Complete chaos testing scenarios (network partition, node failure)
- [ ] Draft rollback procedure and validate with SRE team
- [ ] Present findings at Thursday's architecture review
- [ ] Update capacity planning spreadsheet with new memory projections

---

## Code Snapshot: Decay Function

Below is the current implementation of the frequency decay function used in the eviction scorer.

```python
import math
from dataclasses import dataclass

@dataclass
class CacheEntry:
    key: str
    frequency: int
    last_access_ts: float

def compute_decayed_score(entry: CacheEntry, now: float, decay_rate: float = 0.0037) -> float:
    """
    Computes an eviction score where lower values are evicted first.
    Combines raw frequency with time-based decay.
    """
    elapsed = max(now - entry.last_access_ts, 0.0)
    decay_factor = math.exp(-decay_rate * elapsed)
    score = entry.frequency * decay_factor
    return score

def select_eviction_candidate(entries: list[CacheEntry], now: float) -> CacheEntry:
    scored = [(compute_decayed_score(e, now), e) for e in entries]
    scored.sort(key=lambda pair: pair[0])
    return scored[0][1]
```

This function is called on every eviction cycle, roughly every 50ms under peak load. Early profiling suggests the `math.exp` call is *not* a bottleneck, contrary to our initial assumption — the sort operation dominates at scale beyond 10k entries.

---

## Risks & Blockers

> [!warning]
> The chaos testing harness has a known issue where simulated node failures do not correctly trigger the rebalancing logic in `shard_manager.go`. This must be resolved before we can sign off on production readiness. **Owner:** Devon Ashworth. **ETA:** End of next week.

Additional risks:

- Memory overhead of 14% may require capacity re-provisioning for three regional clusters.
- The decay constant $\lambda$ was tuned on staging traffic; production traffic patterns may differ enough to require re-tuning.
- One engineer (Marcus Webb) is out on leave for two weeks, which may slow down the chaos testing workstream.

---

## Next Steps

1. Complete chaos testing scenarios by end of Week 10.
2. Re-run benchmarks against a production traffic shadow (not just synthetic) to validate real-world hit ratio gains.
3. Finalize rollback runbook and get sign-off from the SRE on-call rotation.
4. Schedule a go/no-go decision meeting for the canary rollout to `prod-us-east-1`, tentatively set for **October 3rd**.
5. Begin drafting the capacity planning update reflecting the projected 14% memory overhead across affected clusters.

We remain *cautiously optimistic* about hitting our target of a 30%+ reduction in p99 latency by the end of Q3, though the chaos testing blocker is the primary risk to that timeline.

---

*Report compiled by the Aurora core team. Questions or feedback welcome in the #aurora-project Slack channel.*
