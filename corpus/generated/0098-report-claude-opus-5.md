# Project Halyard — Status Report

**Reporting period:** March 3 – March 28, 2025
**Prepared by:** Ineke Ferrand, Engineering Lead, Platform Data Services
**Distribution:** Steering Committee, Platform Guild, SRE On-Call Rotation
**Overall status:** 🟡 Amber — on track for the June milestone, but carrying two unresolved risks around schema migration throughput and vendor rate limits.

---

## 1. Executive Summary

Project Halyard replaces the legacy ingestion pipeline (internally, "Coldwater") with a streaming architecture built on partitioned event logs, a schema registry, and a set of stateless transform workers. The goal is to reduce end-to-end ingestion latency from a median of 42 minutes to under 90 seconds, while cutting the per-event cost of processing by at least half.

This period we completed the cutover of the first three tenant cohorts, representing roughly 38% of daily event volume. Median end-to-end latency for migrated traffic is now 71 seconds, comfortably under target. Cost per million events dropped from $4.18 to $2.31, a 44.7% reduction — short of the 50% goal but trending correctly as we retire the parallel-run infrastructure.

The amber status reflects two things. First, the schema migration tooling is slower than modeled: we can convert about 140 table definitions per week against a plan of 220, which pushes the final cohort's cutover from May 16 to approximately May 30 unless we add capacity. Second, our downstream enrichment vendor (Marchetti Data Services) has been throttling us at 1,200 requests per second during peak windows, against a contracted 2,000. We have opened a commercial escalation.

---

## 2. Metrics

### 2.1 Delivery Metrics

| Metric | Baseline (Jan 6) | Last period | This period | Target (Jun 30) |
|---|---|---|---|---|
| Tenant cohorts migrated | 0 / 9 | 1 / 9 | 3 / 9 | 9 / 9 |
| Daily event volume on new pipeline | 0% | 11.4% | 38.2% | 100% |
| Table definitions converted | 0 | 186 | 512 | 1,340 |
| Open migration defects (P1/P2) | — | 9 / 31 | 4 / 22 | 0 / ≤10 |
| Runbook coverage for new services | 0% | 45% | 82% | 100% |

### 2.2 Performance Metrics

| Metric | Coldwater (legacy) | Halyard (current) | Target |
|---|---|---|---|
| Median end-to-end latency | 42 min 10 s | 71 s | ≤ 90 s |
| p95 end-to-end latency | 3 h 04 m | 4 m 12 s | ≤ 6 m |
| p99 end-to-end latency | 9 h 51 m | 11 m 38 s | ≤ 15 m |
| Throughput ceiling (events/s, sustained) | 18,400 | 61,900 | ≥ 55,000 |
| Cost per million events | $4.18 | $2.31 | ≤ $2.09 |
| Replay time for 24 h of traffic | 26 h | 2 h 47 m | ≤ 4 h |

### 2.3 Reliability Metrics

- **Availability of the ingestion API (migrated cohorts):** 99.982% against a 99.95% SLO. Error budget consumed this period: 34%.
- **Transform worker crash loops:** 6 incidents, all traced to a single deserialization bug fixed in build `hal-2.9.4`.
- **Dead-letter queue depth (rolling 7-day mean):** 418 events, down from 3,102 at the start of the period. Every dead-lettered event now carries a structured failure reason, which cut triage time per batch from ~40 minutes to ~7.
- **Mean time to detect (MTTD):** 3 m 20 s. **Mean time to restore (MTTR):** 27 m. Both within our internal guardrails of 5 m and 45 m respectively.

---

## 3. What Shipped

1. **Cohort cutovers for Aurelian Retail, Kestrel Logistics, and the internal Analytics tenant.** All three ran in shadow mode for a minimum of ten days with a divergence threshold of 0.02% before traffic was flipped. Actual observed divergence at cutover: 0.004%, 0.011%, and 0.000% respectively.
2. **Schema registry v2** with backward- and forward-compatibility checks enforced at publish time. Producers now fail fast at CI rather than at runtime; we have rejected 61 incompatible schema pushes since enabling the gate on March 11.
3. **Adaptive batching in the transform workers.** Workers now size batches against observed downstream latency rather than a fixed count of 500. This alone accounted for an estimated 19% of the cost reduction.
4. **Structured dead-letter envelopes,** described below.
5. **Replay CLI (`halyard-replay`)** with time-window and tenant-scoped selectors, plus a dry-run mode that reports projected cost before execution.
6. **Automated runbook linting,** which flags runbooks that reference retired alert names or dashboards. This caught 14 stale documents.

### 3.1 Dead-Letter Envelope Format

Every event that fails a transform is now wrapped in a stable envelope before it lands in the dead-letter topic. This replaced an ad-hoc string log line that was effectively un-queryable.

```json
{
  "envelope_version": "2.1",
  "event_id": "evt_7f3a91cc4d2b",
  "tenant": "kestrel-logistics",
  "ingested_at": "2025-03-24T14:07:52.418Z",
  "failed_at": "2025-03-24T14:07:52.907Z",
  "pipeline_stage": "enrichment",
  "failure": {
    "class": "UpstreamRateLimited",
    "retryable": true,
    "attempt": 3,
    "detail": "marchetti: 429 after 3 attempts, backoff exhausted",
    "next_eligible_at": "2025-03-24T14:37:52.907Z"
  },
  "schema": {
    "subject": "logistics.shipment.v4",
    "registry_id": 8814
  },
  "payload_ref": "s3://halyard-dlq/2025/03/24/kestrel/7f3a91cc4d2b.avro"
}
```

Note that the payload itself is stored by reference rather than inline. This keeps the dead-letter topic small enough to retain for 30 days without a storage exception, and it means we can apply the same retention and redaction policy to failed payloads as to successful ones.

---

## 4. Risks and Issues

### Risk R-04: Schema conversion throughput (High, likely)

The converter handles straightforward column-type mappings well but stalls on the roughly 30% of legacy tables that use composite keys with implicit ordering. Each of those requires a human decision about key stability. At 140 tables per week we finish on May 30; the plan assumed May 16.

**Mitigation options under evaluation:** (a) borrow two engineers from the Foghorn team for four weeks, (b) accept a two-week schedule slip, (c) migrate the final cohort with a temporary compatibility shim and convert its schemas post-cutover. Option (c) is technically feasible but adds an estimated $9,400/month in shim infrastructure until retired. Recommendation to Steering: pursue (a), fall back to (b).

### Risk R-07: Vendor rate limiting (High, occurring)

Marchetti Data Services is enforcing 1,200 rps during our 09:00–11:00 peak, against a contracted ceiling of 2,000 rps. This produced 11,700 retryable dead-letters this period. Our client-side backoff absorbs the impact — no data loss — but p99 latency for enrichment-dependent events rises to 11 m 38 s during those windows, consuming most of our p99 headroom.

Commercial escalation opened March 19; vendor response due April 4. Engineering mitigation in flight: a local enrichment cache for the 800 most-requested entity keys, which we estimate would cut outbound requests by 34%.

### Issue I-11: Cost attribution gaps (Medium)

Roughly $3,100/month of pipeline spend lands in an unattributed bucket because the parallel-run infrastructure shares a cluster with the new workers. This resolves itself when Coldwater is decommissioned, but it means our current cost-per-million figure carries a margin of error of about ±6%.

---

## 5. Next Steps

**April 1 – April 11**

1. Ship the local enrichment cache behind a feature flag; validate hit rate against replayed peak traffic before enabling in production.
2. Complete shadow-mode runs for cohorts 4 and 5 (Brightwell Health, Talon Payments).
3. Close the remaining four P1 migration defects, all of which relate to timezone handling in legacy timestamp columns.
4. Deliver a capacity proposal to Steering for the R-04 mitigation decision by April 8.

**April 14 – April 30**

5. Cut over cohorts 4 and 5, targeting a combined 61% of daily volume on the new pipeline.
6. Begin decommissioning the first Coldwater shard, which should recover roughly $1,900/month and close part of I-11.
7. Raise runbook coverage from 82% to 100% and run a game day exercising a full-region transform worker loss.

**May**

8. Cut over cohorts 6 through 9, subject to the R-04 decision.
9. Complete the cost-attribution rework so June reporting is clean.

---

## 6. Asks of the Steering Committee

- **Decision by April 8** on the R-04 staffing request: two engineers from Foghorn for four weeks, or acceptance of a two-week slip to June 13 for full cutover.
- **Support on the Marchetti escalation** — a commercial nudge at the account level would help more than further engineering workarounds.
- **Confirmation** that the 44.7% cost reduction achieved to date, trending to roughly 52% post-decommission, satisfies the program's financial objective.
