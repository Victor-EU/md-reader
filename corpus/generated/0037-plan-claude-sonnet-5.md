# Project Helios: Customer Analytics Platform Migration

## Overview

**Project Helios** is an internal initiative to migrate the legacy customer analytics stack (built on *Aurora DB* and the deprecated *Finchwright ETL* pipeline) to a modern, cloud-native architecture based on **Trellisdata Warehouse** and **Kestrel Orchestrator**. The migration is sponsored by the Data Platform division and is expected to run for approximately 22 weeks, from March through August, with a projected budget of **$418,000**.

The project's guiding principle is that data latency should be reduced from the current daily batch cycle to near real-time streaming, while preserving ==full backward compatibility== with existing dashboards used by the Sales and Retention teams.

---

## Objectives

1. Migrate all historical customer event data (approximately 3.2 billion records) into Trellisdata Warehouse without data loss.
2. Reduce average query latency for the top 50 dashboard queries from 4.7 seconds to under 1.2 seconds.
3. Establish an automated data-quality monitoring layer with alerting thresholds.
4. Decommission the legacy Finchwright pipeline by the project's final phase.
5. Train at least 30 downstream analysts on the new query interface before cutover.

---

## Phases and Milestones

### Phase 1 — Discovery & Architecture (Weeks 1–4)

This phase focuses on requirements gathering, data profiling, and architectural decisions. The team will audit all 214 existing ETL jobs and classify them by complexity and business criticality.

- **Milestone 1.1**: Data inventory and lineage map completed — *Owner: Priya Nandakumar (Data Architect)*
- **Milestone 1.2**: Target schema design approved by stakeholders — *Owner: Owen Baptiste (Lead Engineer)*
- **Milestone 1.3**: Migration risk register finalized — *Owner: Dana Feldstein (Project Manager)*

> [!note]
> The discovery phase includes a two-day workshop with the Sales Analytics team to validate that dashboard semantics (e.g., "active customer" definitions) are preserved exactly. Any ambiguity here compounds downstream.

### Phase 2 — Pipeline Construction (Weeks 5–11)

The engineering team builds the new ingestion pipelines using Kestrel Orchestrator, replacing the batch-oriented Finchwright jobs with streaming equivalents. A simplified staging job might look like this:

```python
from kestrel import Stream, Sink

def build_customer_event_pipeline():
    source = Stream.from_kafka(topic="customer_events_v2")
    transformed = (
        source
        .filter(lambda e: e["event_type"] != "internal_test")
        .map(normalize_timestamp)
        .window(size_minutes=5)
    )
    sink = Sink.to_trellisdata(table="fact_customer_events")
    transformed.write(sink)

if __name__ == "__main__":
    build_customer_event_pipeline()
```

- **Milestone 2.1**: Streaming ingestion prototype validated on staging data — *Owner: Owen Baptiste*
- **Milestone 2.2**: 80% of ETL jobs re-implemented in Kestrel — *Owner: Marcus Ilunga (Data Engineer)*
- **Milestone 2.3**: Parallel-run validation shows <0.01% record discrepancy — *Owner: Priya Nandakumar*

*Parallel running* — where old and new pipelines operate simultaneously against production data — is considered the single most important validation mechanism in this phase.

### Phase 3 — Query Performance Optimization (Weeks 12–16)

Once data flows reliably into Trellisdata, the focus shifts to optimizing the top-tier dashboard queries. The team will apply indexing strategies, materialized views, and query rewriting.

We model expected latency improvement using a simple decay function. If $L_0$ is the baseline latency and $r$ is the per-optimization-round reduction factor, then after $n$ rounds of tuning:

$$
L_n = L_0 \cdot r^{n} + \epsilon
$$

where $\epsilon$ represents an irreducible latency floor caused by network round-trip time. Early benchmarking suggests $r \approx 0.62$ per round, meaning three rounds should be sufficient to reach the target latency of under 1.2 seconds, since $L_0 \approx 4.7$ gives $L_3 \approx 1.11$ before accounting for $\epsilon$.

- **Milestone 3.1**: Top 10 highest-traffic queries optimized — *Owner: Renata Sokolova (Performance Engineer)*
- **Milestone 3.2**: Materialized view refresh strategy documented — *Owner: Marcus Ilunga*
- **Milestone 3.3**: Latency benchmarks published to stakeholders — *Owner: Dana Feldstein*

### Phase 4 — Data Quality & Monitoring (Weeks 15–18)

This phase overlaps intentionally with Phase 3 to allow monitoring infrastructure to mature alongside optimized queries. The data-quality framework will track completeness, freshness, and schema drift metrics.

> [!warning]
> Historical data audits uncovered that roughly **6.4%** of legacy records contain malformed customer ID fields due to a 2019 encoding bug in Aurora DB. These records must be flagged, not silently dropped, or downstream churn models will be skewed.

- **Milestone 4.1**: Data-quality dashboard deployed — *Owner: Priya Nandakumar*
- **Milestone 4.2**: Alerting thresholds calibrated against 90 days of historical variance — *Owner: Renata Sokolova*
- **Milestone 4.3**: Malformed-record remediation plan approved — *Owner: Owen Baptiste*

### Phase 5 — Training & Cutover (Weeks 19–22)

The final phase transitions users to the new platform and formally decommissions the legacy system.

1. Conduct four training sessions covering the new query interface and dashboard tooling.
2. Run a **one-week shadow period** where both systems remain live but Trellisdata is the system of record.
3. Collect analyst feedback via structured survey and address critical issues.
4. Execute final cutover, redirecting all dashboard traffic to Trellisdata.
5. Decommission Finchwright infrastructure and archive Aurora DB snapshots for compliance retention (7 years).

- **Milestone 5.1**: Training completed for 30+ analysts — *Owner: Dana Feldstein*
- **Milestone 5.2**: Shadow period completed with zero critical incidents — *Owner: Marcus Ilunga*
- **Milestone 5.3**: Legacy system decommissioned — *Owner: Owen Baptiste*

---

## Risk Register

| Risk | Likelihood | Impact | Owner | Mitigation |
|---|---|---|---|---|
| Data lineage gaps discovered late | Medium | High | Priya Nandakumar | Front-load discovery workshops; require sign-off before Phase 2 begins |
| Streaming pipeline introduces duplicate events | Medium | Medium | Marcus Ilunga | Idempotency keys on all ingestion writes |
| Query optimization fails to hit latency target | Low | High | Renata Sokolova | Reserve buffer week in Phase 3 for additional tuning rounds |
| Analyst adoption resistance | Medium | Medium | Dana Feldstein | Early involvement of power users as internal champions |
| Legacy encoding bug affects more records than estimated | Low | High | Owen Baptiste | Expand audit sample size before remediation plan is finalized |
| Budget overrun due to extended parallel-run period | Medium | Medium | Dana Feldstein | Set a hard four-week cap on parallel running with executive review |

---

## Governance and Communication

Weekly status meetings will be held every Thursday, with a rotating chair among phase owners. A **RAID log** (Risks, Assumptions, Issues, Dependencies) will be maintained in the shared project tracker and reviewed at each milestone checkpoint. Escalations that cannot be resolved within the working group will be routed to the Data Platform steering committee within 48 hours.

Success of Project Helios will ultimately be measured not just by technical benchmarks, but by whether the *people* who rely on these dashboards daily feel the transition was smooth, transparent, and worth the disruption.
