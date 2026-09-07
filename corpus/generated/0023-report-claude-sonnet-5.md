# Project Status Report: Helios Data Pipeline Optimization

**Project Lead:** Priya Nakamura
**Report Date:** March 14, 2025
**Sprint:** 14 of 22
**Status:** 🟡 On Track with Minor Risks

---

## Executive Summary

The Helios Data Pipeline Optimization project has completed its fourteenth sprint, focusing on reducing end-to-end latency in our streaming ingestion layer and improving the reliability of our downstream aggregation services. Overall progress remains steady, with throughput improvements exceeding our Q1 targets, though we've encountered a memory leak in the checkpointing subsystem that requires attention before the next release.

> [!note]
> This report covers work completed between February 24 and March 13, 2025. The next status report will be published on March 28, 2025.

---

## Key Metrics

### Throughput and Latency

Our primary performance indicator, average end-to-end latency $\bar{L}$, dropped from 842ms to 611ms this sprint, a **27.4% improvement**. This was driven largely by the introduction of batched writes to our object store and a reduction in serialization overhead.

The relationship between batch size $b$ and observed latency $L(b)$ has been modeled empirically as:

$$
L(b) = \alpha \cdot \frac{1}{b} + \beta \cdot b + \gamma
$$

where $\alpha = 4200$, $\beta = 0.85$, and $\gamma = 96$ (all in milliseconds, with $b$ measured in number of records per batch). Solving for the optimal batch size by setting $\frac{dL}{db} = 0$ gives us $b^* = \sqrt{\alpha/\beta} \approx 70$ records per batch, which aligns closely with the value of 64 currently configured in production.

| Metric | Sprint 13 | Sprint 14 | Delta |
|---|---|---|---|
| Avg. latency (ms) | 842 | 611 | -27.4% |
| P99 latency (ms) | 2,150 | 1,780 | -17.2% |
| Throughput (events/sec) | 18,400 | 22,900 | +24.5% |
| Error rate (%) | 0.42 | 0.31 | -26.2% |
| Memory usage (GB, avg) | 3.8 | 4.6 | +21.1% |

### Cost Efficiency

Infrastructure costs for the pipeline decreased slightly despite the throughput gains, primarily due to right-sizing our worker node pool. Monthly compute spend fell from $14,320 to $13,860, a reduction of approximately 3.2%. Storage costs remained flat at roughly $2,100/month.

---

## Work Completed This Sprint

1. Migrated the ingestion service from synchronous HTTP calls to an async event bus using our internal `EventRouter` library.
2. Implemented adaptive batching logic in the writer module, replacing the previously static batch size configuration.
3. Added distributed tracing spans across all six microservices in the pipeline, improving our ability to diagnose latency spikes.
4. Refactored the checkpointing subsystem to use a write-ahead log (WAL) pattern instead of periodic snapshots.
5. Conducted a load test simulating 3x normal traffic to validate autoscaling behavior under stress.

---

## Technical Deep Dive: Checkpointing Memory Leak

During the load test on March 10, engineers observed steadily increasing memory consumption in the checkpointing service, eventually triggering OOM kills after approximately six hours of sustained load. Investigation traced the issue to unreleased references in the WAL buffer pool.

Below is a simplified reproduction of the problematic pattern found in `checkpoint_writer.py`:

```python
class WALBufferPool:
    def __init__(self, max_size=1024):
        self.buffers = []
        self.max_size = max_size

    def acquire(self):
        buf = bytearray(self.max_size)
        self.buffers.append(buf)  # bug: never removed on release
        return buf

    def release(self, buf):
        # Missing: self.buffers.remove(buf)
        pass

    def flush_to_disk(self, path):
        with open(path, "ab") as f:
            for buf in self.buffers:
                f.write(buf)
        # buffers list grows unbounded over time
```

> [!warning]
> This memory leak has the potential to cause production outages under sustained high-throughput conditions. A hotfix is scheduled for deployment on March 17, 2025, ahead of the next scheduled release window.

The fix involves properly removing buffers from the pool upon release and adding a periodic garbage collection pass. We've also added a unit test to catch regressions:

```python
def test_buffer_pool_releases_memory():
    pool = WALBufferPool(max_size=256)
    buf = pool.acquire()
    assert len(pool.buffers) == 1
    pool.release(buf)
    assert len(pool.buffers) == 0
```

---

## Risk Register

The following risks have been identified and are being actively tracked by the team:

- **Memory management risks**
  - Checkpointing WAL buffer leak (High severity, hotfix in progress)
    - Root cause identified and confirmed via heap profiling
    - Fix implemented in feature branch `fix/wal-buffer-leak`
    - Regression test suite expanded to cover edge cases
  - Potential leak in metrics collector under high cardinality labels (Medium severity, under investigation)
    - Suspected cause: unbounded label cardinality in Prometheus exporter
    - Mitigation: enforce label cardinality limits at ingestion
- **Scaling risks**
  - Autoscaler responsiveness under sudden traffic spikes (Low severity, monitoring)
    - Current scale-up delay averages 45 seconds
    - Target is to reduce this to under 20 seconds by Sprint 16
    - Considering predictive scaling based on historical traffic patterns
- **Dependency risks**
  - Upstream schema registry service has an unpatched CVE (Medium severity)
    - Patch expected from vendor by March 20, 2025
    - Interim mitigation: network-level access restrictions applied

---

## Team Velocity and Capacity

Our team completed 47 story points this sprint against a planned 52, resulting in a velocity of approximately 90.4%. This slight shortfall is attributed to unplanned work addressing the memory leak described above. The team's rolling four-sprint average velocity stands at 49.2 points, which we consider our stable baseline for planning purposes going forward.

Team composition remained unchanged, with six engineers (four backend, one SRE, one data engineer) contributing across the sprint. No planned time off significantly impacted capacity during this period.

---

## Budget Status

Total project budget remains on track. Of the allocated $340,000 for this fiscal quarter, $198,450 has been spent to date, representing 58.4% utilization against a timeline that is approximately 63.6% complete. This suggests we may finish slightly under budget, assuming no major scope changes in the remaining sprints.

---

## Next Steps

For Sprint 15, the team will prioritize the following objectives:

1. Deploy the WAL buffer pool hotfix to production and monitor for 72 hours before declaring the incident resolved.
2. Begin implementation of predictive autoscaling using a simple exponential smoothing model, where the forecasted load $\hat{y}_{t+1}$ is computed as:

$$
\hat{y}_{t+1} = \theta \cdot y_t + (1 - \theta) \cdot \hat{y}_t
$$

with a smoothing factor $\theta = 0.3$ chosen based on backtesting against the last twelve weeks of traffic data.
3. Complete the migration of the aggregation service to the new async event bus, which was deferred from this sprint due to the memory leak investigation.
4. Conduct a security review of the schema registry dependency and apply the interim network restrictions permanently if the vendor patch is delayed further.
5. Update internal documentation to reflect the new checkpointing architecture, including updated runbooks for on-call engineers.

---

## Stakeholder Actions Requested

- **Engineering Leadership:** Please review and approve the emergency hotfix deployment window scheduled for March 17.
- **Finance:** No action needed at this time; budget utilization remains healthy.
- **Product Team:** Input requested on prioritization between the aggregation service migration and predictive autoscaling work for Sprint 16, as both cannot be fully completed given current capacity constraints.

---

*This report was compiled by Priya Nakamura with contributions from the Helios engineering team. Questions or feedback can be directed to the #helios-pipeline Slack channel.*
