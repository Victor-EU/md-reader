# Project Halyard — Engineering Status Report

**Reporting period:** March 3 – March 16, 2025
**Author:** Dalia Nkemelu, Staff Engineer, Payments Platform
**Distribution:** Platform Leadership, Billing Guild, SRE On-Call Rotation
**Status:** 🟡 Amber (schedule risk, quality on track)

---

## 1. Executive Summary

Halyard is the twelve-month effort to decompose the legacy `ledger-core` monolith into four bounded services (`entry-writer`, `balance-projector`, `settlement-gateway`, `dispute-engine`) backed by an append-only event log. We closed Milestone 4 (dual-write shadow traffic at 100%) six days later than planned, and we are now holding Milestone 5 (read cutover for internal consumers) at 62% completion.

The delay traces almost entirely to a single defect class: clock-skew-induced ordering violations in the `balance-projector` when partition leadership moves between availability zones. We shipped a mitigation on March 11 that reduced the violation rate from 41 per million events to 0.7 per million, but the residual rate remains above our 0.1 per million exit criterion. Two engineers are dedicated to closing this gap through March 28.

Everything else is green. Shadow-traffic parity has held above 99.98% for eleven consecutive days, p99 write latency is 38% better than the monolith baseline, and infrastructure spend is tracking 9% under the approved envelope.

---

## 2. Milestone Progress

| # | Milestone | Target | Forecast | State |
|---|-----------|--------|----------|-------|
| 1 | Event schema registry live | Nov 15 | Nov 12 | ✅ Done |
| 2 | `entry-writer` GA (internal) | Dec 20 | Dec 22 | ✅ Done |
| 3 | Dual-write at 10% | Jan 24 | Jan 24 | ✅ Done |
| 4 | Dual-write at 100% | Mar 7 | Mar 13 | ✅ Done (late) |
| 5 | Internal read cutover | Apr 4 | Apr 11 | 🟡 62% |
| 6 | External read cutover | May 16 | May 23 | ⬜ Not started |
| 7 | Monolith read path retired | Jun 27 | Jul 4 | ⬜ Not started |
| 8 | `ledger-core` decommission | Aug 29 | Aug 29 | ⬜ Not started |

Slack in the plan totals 21 working days; we have consumed 7. No milestone dates have been formally rebaselined, though Milestone 6 is the first one where the forecast eats into contractual commitments with the Reconciliation team.

---

## 3. Metrics

### 3.1 Performance (production shadow traffic, 14-day window)

| Metric | Monolith baseline | Halyard | Delta |
|--------|------------------:|--------:|------:|
| Write p50 (ms) | 84 | 47 | −44% |
| Write p99 (ms) | 612 | 379 | −38% |
| Projection lag p99 (ms) | n/a | 1,240 | — |
| Sustained throughput (events/s) | 4,100 | 11,600 | +183% |
| Peak observed (events/s) | 6,850 | 19,200 | +180% |
| Cold-start to ready (s) | 143 | 19 | −87% |

### 3.2 Correctness and reliability

| Metric | Target | Current | Trend |
|--------|-------:|--------:|-------|
| Shadow parity (ledger totals) | ≥ 99.99% | 99.983% | ↗ |
| Ordering violations / 1M events | ≤ 0.10 | 0.70 | ↘ |
| Availability (30-day, internal SLO) | 99.95% | 99.972% | → |
| Error budget consumed (quarter) | ≤ 100% | 34% | ↗ |
| Unplanned pages (period) | ≤ 4 | 6 | ↗ |
| Mean time to acknowledge (min) | ≤ 5 | 3.1 | → |

### 3.3 Engineering hygiene

| Metric | Target | Current |
|--------|-------:|--------:|
| Line coverage, new services | 80% | 87.4% |
| Mutation score, `balance-projector` | 65% | 58.2% |
| Open Sev-2 defects | ≤ 5 | 3 |
| Median PR review time (h) | ≤ 8 | 5.6 |
| Flaky test rate | ≤ 1.0% | 2.3% |
| Build p95 duration (min) | ≤ 12 | 14.7 |

Flaky tests and build duration are the two hygiene metrics out of bounds. Both stem from the integration suite spinning up real broker containers per test class; a shared-fixture refactor is scheduled for sprint 19.

---

## 4. Technical Detail: The Ordering Mitigation

The projector previously trusted broker-assigned timestamps to order entries within an account partition. When leadership migrated across zones, a skew of up to 340 ms could invert two entries posted within the same window. We replaced wall-clock ordering with a per-account monotonic sequence issued by `entry-writer`, plus a bounded reorder buffer that holds out-of-sequence arrivals before applying them.

```yaml
# halyard/config/projector.prod.yaml
projector:
  ordering:
    strategy: account_sequence      # was: broker_timestamp
    reorder_buffer:
      max_events: 512
      max_hold_ms: 750
      on_gap_timeout: quarantine    # emit to halyard.quarantine.v1
    duplicate_policy: idempotent_upsert
  checkpoint:
    interval_events: 2000
    interval_ms: 500
    store: dynamo://halyard-checkpoints-prod
  backpressure:
    high_watermark_lag_ms: 5000
    action: pause_partition
    resume_below_ms: 1500
  observability:
    emit_sequence_gap_metric: true
    sample_rate: 0.05
```

Residual violations now occur only when the reorder buffer times out during a broker restart and events land in quarantine. Manual replay of quarantined events is currently a runbook step; automating it is the top item in section 6.

---

## 5. Risks and Issues

| ID | Description | Severity | Owner | Mitigation |
|----|-------------|----------|-------|------------|
| R-12 | Residual ordering violations block Milestone 5 exit | High | Nkemelu | Automated quarantine replay, target Mar 28 |
| R-17 | Reconciliation team has no staging environment until Apr 21 | Medium | Ostrowski | Negotiating a shared sandbox slice |
| R-19 | Single engineer holds settlement-gateway context | Medium | Vance | Pairing rotation started Mar 10 |
| R-21 | Broker upgrade (3.7 → 3.9) collides with cutover window | Medium | SRE Guild | Requested deferral to July |
| R-24 | Flaky tests eroding confidence in release gate | Low | Ferreira | Fixture refactor, sprint 19 |

Two issues were closed this period: the schema-registry authorization gap (R-08) and the oversized checkpoint payloads that caused throttling on the checkpoint table (R-15).

---

## 6. Next Steps

**Sprint 19 (Mar 17 – Mar 28)**

1. Ship automated quarantine replay with idempotency guards; exit criterion is ordering violations ≤ 0.10 per million across a 7-day window.
2. Complete read-path adapters for the three remaining internal consumers: `invoice-render`, `tax-calc`, and `partner-payouts`.
3. Refactor the integration suite to a shared broker fixture; target flaky rate below 1.0% and build p95 below 12 minutes.
4. Publish the Milestone 5 cutover runbook and hold a tabletop exercise with SRE on March 26.

**Sprint 20 (Mar 31 – Apr 11)**

1. Execute the internal read cutover in three tranches (5%, 40%, 100%) with a 24-hour soak between tranches.
2. Stand up the dispute-engine load harness at 3× projected peak.
3. Begin external consumer onboarding documentation ahead of Milestone 6.

**Decisions requested from leadership by March 21**

- Approve deferral of the broker upgrade to the July maintenance window (R-21).
- Confirm whether Milestone 6 may slip one week without renegotiating the Reconciliation contract, or whether we should add a fifth engineer to hold the original date.
- Authorize a $14,000 increase in the quarterly load-testing budget to cover the dispute-engine harness.
