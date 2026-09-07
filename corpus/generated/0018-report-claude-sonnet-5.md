# Project Orion: Distributed Cache Optimization — Status Report

**Date:** March 14, 2025
**Author:** Priya Ramanathan, Lead Infrastructure Engineer
**Sprint:** 14 of 20
**Status:** 🟡 On Track (Minor Risks Identified)

---

## Executive Summary

Project Orion aims to reduce p99 latency across our distributed caching layer by replacing the legacy LRU eviction policy with an adaptive, cost-aware eviction algorithm we call **W-TinyLFU-X**. Over the past three sprints, we've moved from prototype to staged rollout in two of six production regions. Early results are promising, but we've encountered unexpected memory fragmentation issues under high cardinality workloads that require attention before wider deployment.

> [!note]
> This report covers Sprints 12–14. The previous report (Sprint 11) can be found in `docs/reports/2025-02-21-orion-status.md`.

---

## Key Metrics

### Cache Performance (Region: `us-east-2`, canary cluster)

| Metric | Baseline (LRU) | Current (W-TinyLFU-X) | Δ |
|---|---|---|---|
| Hit Rate | 87.2% | 94.6% | +7.4 pp |
| p50 Latency | 1.8 ms | 1.1 ms | −38.9% |
| p99 Latency | 42.3 ms | 19.7 ms | −53.4% |
| Memory Overhead | 4.1% | 6.8% | +2.7 pp |
| Eviction Throughput | 12,400 ops/s | 15,900 ops/s | +28.2% |

The theoretical hit-rate improvement predicted by our simulation model was:

$$
H_{\text{predicted}} = 1 - \frac{1}{1 + \alpha \cdot \log_2\left(\frac{N}{k}\right)}
$$

where $N$ is the total key space size, $k$ is the cache capacity, and $\alpha = 0.83$ is the empirically fitted admission-filter sensitivity constant. Our observed hit rate of $94.6\%$ tracks the prediction within a margin of $\epsilon = 1.2\%$, which is within our acceptable tolerance of $\epsilon_{\max} = 2.0\%$.

### Infrastructure Cost

- Monthly compute spend (canary): **$4,280** (up from $3,950 baseline, +8.4%)
- Projected full-rollout savings (via reduced backend DB load): **$61,000/month**
- Break-even point: approximately **7 weeks** post full rollout

---

## Technical Deep Dive: Memory Fragmentation Issue

During load testing with the `synthetic-highcard-v3` benchmark (2.1M unique keys, Zipfian distribution with $s = 1.05$), we observed heap fragmentation climbing steadily over a 6-hour soak test.

```rust
// Simplified excerpt from src/cache/allocator.rs
// Demonstrates the segment reuse logic under investigation

pub struct SegmentPool {
    free_list: Vec<Segment>,
    active: HashMap<SegmentId, Segment>,
}

impl SegmentPool {
    pub fn reclaim(&mut self, id: SegmentId) -> Result<(), PoolError> {
        let seg = self.active.remove(&id)
            .ok_or(PoolError::NotFound)?;

        // BUG SUSPECT: segments below this threshold are not
        // being coalesced with adjacent free blocks, causing
        // fragmentation to accumulate over long-running processes.
        if seg.size < COALESCE_THRESHOLD {
            self.free_list.push(seg);
        } else {
            self.coalesce_and_push(seg)?;
        }

        Ok(())
    }
}
```

The root cause appears to be the `COALESCE_THRESHOLD` constant (currently `4096` bytes), which was tuned for our original workload profile but does not generalize well to high-cardinality small-object patterns. We're evaluating a dynamic threshold based on recent allocation size histograms.

> [!warning]
> If left unresolved, this fragmentation issue could cause OOM kills in long-running cache nodes (uptime > 72 hours) under high-cardinality workloads. This is a **blocking issue** for the `ap-southeast-1` rollout, currently scheduled for Sprint 16.

---

## Regional Rollout Status

- **us-east-2**: Canary deployment, 12% of traffic
  - Stable for 19 days
  - No fragmentation issues observed (lower cardinality workload)
- **us-west-1**: Canary deployment, 8% of traffic
  - Stable for 11 days
  - Minor alerting noise from Prometheus rules (false positives)
- **eu-central-1**: Planning phase
  - Dependent on fragmentation fix
- **ap-southeast-1**: Blocked
  - Awaiting fragmentation resolution
- **ap-northeast-1**: Not started
- **sa-east-1**: Not started

### Team Structure (nested breakdown)

- **Core Engineering**
  - Cache Algorithm Team
    - Priya Ramanathan (lead)
    - Dmitri Volkov (eviction policy tuning)
    - Aisha Bello (benchmarking harness)
      - Owns `synthetic-highcard-v3` and related fixtures
      - Coordinating with SRE on soak test infrastructure
  - Platform Reliability Team
    - Marcus Chen (on-call rotation lead)
    - Sofia Petrova (alerting/observability)
  - Infrastructure Cost Team
    - Wei Zhang (FinOps liaison)
- **Stakeholders**
  - Product: Lena Kowalski
  - SRE Leadership: Tomás Herrera

---

## Incident Log Since Last Report

There was one Sev-3 incident during the reporting period:

> On March 8th at 03:14 UTC, the `us-west-1` canary cluster experienced a 4-minute partial degradation (elevated p99 latency, peaking at 210ms) due to a misconfigured connection pool size following a routine node restart. No customer-facing errors were recorded; the issue was caught by internal synthetic monitoring before user impact thresholds were crossed. Root cause: connection pool max size was not correctly propagated from the updated Helm chart values.

Postmortem document: `docs/incidents/2025-03-08-uswest1-degradation.md`

---

## Task List — Sprint 14 Deliverables

- [x] Finalize W-TinyLFU-X admission filter tuning for `us-east-2`
- [x] Deploy observability dashboards for eviction latency (Grafana)
- [x] Complete root-cause investigation for segment fragmentation
- [ ] Implement dynamic `COALESCE_THRESHOLD` based on allocation histograms
- [ ] Run 72-hour soak test with fragmentation fix applied
- [x] Update runbooks for on-call engineers regarding new eviction metrics
- [ ] Present findings to Platform Reliability Team for sign-off
- [ ] Begin `eu-central-1` staging environment provisioning
- [ ] Draft cost-benefit analysis for full six-region rollout

---

## Risks and Mitigations

1. **Memory fragmentation under high cardinality** (High severity)
   - Mitigation: dynamic threshold patch in progress, target completion Sprint 15
2. **Alerting noise in canary regions** (Low severity)
   - Mitigation: Sofia's team is auditing Prometheus rule sensitivity
3. **Cost overrun risk if rollout delayed past Q2** (Medium severity)
   - Mitigation: Wei is preparing a revised budget forecast assuming a 4-week slip

---

## Next Steps

1. Land the dynamic coalescing threshold patch (target: March 19th)
2. Re-run the 72-hour soak test on the patched build in a staging environment mirroring `ap-southeast-1` traffic patterns
3. If soak test passes cleanly (fragmentation growth rate $< 0.5\%$ per hour), proceed with `eu-central-1` staging rollout
4. Schedule joint review with SRE leadership (Tomás) to sign off on `ap-southeast-1` unblock, tentatively March 26th
5. Update the cost model with actual `us-west-1` and `us-east-2` canary data to refine the full-rollout savings projection
6. Begin drafting external-facing changelog entry for the eventual GA announcement, pending legal/PR review

---

## Appendix: Benchmark Configuration Reference

For reproducibility, the benchmark harness parameters used in this reporting period were:

- Key space size ($N$): 2,100,000
- Cache capacity ($k$): 50,000
- Zipfian skew ($s$): 1.05
- Request rate: 18,000 req/s sustained
- Duration: 6 hours (soak), 45 minutes (smoke)

Questions or feedback on this report should be directed to Priya Ramanathan or raised in `#project-orion` on the internal chat platform.
