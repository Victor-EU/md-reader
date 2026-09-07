# Project Cormorant — Status Report

**Reporting period:** 2024-W38 through 2024-W41 (four-week cycle)
**Prepared by:** Dara Okonkwo, Technical Lead, Settlement Platform Guild
**Distribution:** Platform Steering Group, Finance Engineering, Risk & Controls
**Overall status:** 🟡 Amber — on scope, one week behind on schedule, cost tracking favourable

---

## 1. Executive Summary

Project Cormorant replaces **Kestrel**, our nightly batch settlement engine, with **Tidewater**, a streaming settlement pipeline built on an append-only event log. The business objective is to reduce end-of-day settlement finality from a 6-hour batch window to a continuous flow with sub-second per-transaction latency, while preserving byte-for-byte reconciliation parity with the legacy ledger.

During this cycle we completed the dual-write phase for all four settlement domains, shipped the reconciliation harness to production, and ran the first 72-hour shadow comparison against live volume. Shadow parity reached **99.9962%** across 41.2 million compared records, with all 1,566 mismatches traced to three known root causes (two of which are now fixed).

The single schedule slip is in the **payout-reversal** domain, where the legacy engine encodes an undocumented rounding behaviour for multi-currency partial reversals. Resolving it required a controls sign-off that added seven working days. We have absorbed four of those days through parallelisation and expect to recover the remainder in the next cycle.

Cost is running **18% under** the approved infrastructure envelope because the compaction strategy for the event log turned out to be far more effective than modelled.

---

## 2. Milestone Progress

| # | Milestone | Planned | Forecast | Status |
|---|-----------|---------|----------|--------|
| M1 | Event schema v1 frozen in Rookery registry | 2024-08-16 | 2024-08-14 | ✅ Complete |
| M2 | Tidewater ingest at 10k events/s sustained | 2024-09-06 | 2024-09-04 | ✅ Complete |
| M3 | Dual-write enabled for all domains | 2024-09-27 | 2024-10-02 | ✅ Complete |
| M4 | 72-hour shadow parity ≥ 99.99% | 2024-10-11 | 2024-10-09 | ✅ Complete |
| M5 | Payout-reversal parity sign-off | 2024-10-18 | 2024-10-25 | 🟡 At risk |
| M6 | Read-path cutover (10% cohort) | 2024-11-08 | 2024-11-12 | 🟡 At risk |
| M7 | Kestrel decommission | 2025-01-31 | 2025-01-31 | ⬜ Not started |

**Schedule variance:** +5 working days on the critical path (M5 → M6). No change to M7, which retains 21 days of float.

---

## 3. Key Metrics

### 3.1 Performance

| Metric | Baseline (Kestrel) | Last cycle | This cycle | Target |
|--------|--------------------|------------|------------|--------|
| p50 settlement latency | 4h 12m | 210 ms | 148 ms | ≤ 250 ms |
| p99 settlement latency | 6h 40m | 2,410 ms | 337 ms | ≤ 500 ms |
| p99.9 settlement latency | — | 11,900 ms | 1,240 ms | ≤ 2,000 ms |
| Sustained ingest throughput | n/a | 10,400 ev/s | 14,700 ev/s | ≥ 12,000 ev/s |
| Peak ingest (15-min burst) | n/a | 18,200 ev/s | 26,900 ev/s | ≥ 24,000 ev/s |
| Replay speed (cold partition) | n/a | 41k ev/s | 88k ev/s | ≥ 75k ev/s |

The p99 improvement from 2,410 ms to 337 ms came almost entirely from removing a synchronous currency-table lookup that was hitting the shared config database on every event. It is now materialised into the consumer's local state store and refreshed on a change-feed.

### 3.2 Correctness and Quality

| Metric | Last cycle | This cycle | Target |
|--------|------------|------------|--------|
| Shadow parity rate | 99.9713% | 99.9962% | ≥ 99.9990% |
| Records compared (cumulative) | 12.8 M | 41.2 M | 100 M before cutover |
| Open parity defects | 9 | 3 | 0 |
| Unit + integration coverage | 71.4% | 83.1% | ≥ 80% |
| Mutation score (core ledger pkg) | 48% | 66% | ≥ 70% |
| Flaky tests in CI (7-day) | 14 | 4 | ≤ 3 |
| Mean CI pipeline duration | 22m 40s | 13m 05s | ≤ 15m |

### 3.3 Reliability and Cost

| Metric | Last cycle | This cycle | Target |
|--------|------------|------------|--------|
| Tidewater availability (shadow) | 99.87% | 99.96% | ≥ 99.95% |
| Error budget consumed (30-day) | 61% | 24% | ≤ 50% |
| Sev-2 incidents | 2 | 1 | ≤ 1 |
| Consumer lag, p95 (steady state) | 3,900 ev | 610 ev | ≤ 1,500 ev |
| Monthly infra run-rate | $46,200 | $37,800 | ≤ 46,000 |
| Storage per 1M events (post-compaction) | 9.1 GB | 4.4 GB | ≤ 8 GB |

---

## 4. What Shipped This Cycle

### 4.1 Reconciliation Harness (`cormorant-recon`)

The harness pulls the legacy nightly extract and the Tidewater projection, normalises both into a canonical comparison record, and emits a per-field diff stream. It is now running continuously rather than as an ad-hoc job, and publishes parity metrics to Beacon dashboards every five minutes.

The comparison policy is declarative so that Risk & Controls can review tolerances without reading code:

```yaml
# recon/policies/settlement-v3.yaml
policy: settlement-parity
version: 3
sources:
  legacy:
    adapter: kestrel-extract
    partition_key: [settlement_date, entity_id]
    late_arrival_grace: PT45M
  candidate:
    adapter: tidewater-projection
    projection: ledger_entry_v2
    consistency: read_after_watermark

comparison:
  key_fields: [entity_id, instrument_id, value_date, leg_index]
  field_rules:
    - field: gross_amount_minor
      match: exact
    - field: fx_rate
      match: numeric
      tolerance: 0.00000005
    - field: net_amount_minor
      match: exact
      on_mismatch: raise_defect
    - field: booked_at
      match: temporal
      tolerance: PT2S
      note: "legacy stamps at batch flush, candidate at commit"
  ignore_fields:
    - legacy_batch_id
    - kestrel_row_checksum

defects:
  classifier: cormorant.recon.classifiers.RootCauseHeuristic
  auto_group_by: [field, currency_pair, entity_class]
  escalate_after: 25          # identical diffs before paging
  suppression_window: PT6H

reporting:
  sink: beacon://metrics/cormorant.recon
  emit_interval: PT5M
  sample_diffs_retained: 500
```

Grouping mismatches by `(field, currency_pair, entity_class)` was the change that made the parity work tractable. Before that, engineers were triaging individual diffs; afterwards, 1,566 mismatches collapsed into three clusters within about forty minutes.

### 4.2 Parity Defect Register

- **CMR-311 — Rounding on multi-currency partial reversals** *(open, critical path)*
  - Legacy applies half-up rounding at the *leg* level; Tidewater rounds at the *instruction* level.
  - Impact: 1,204 of 1,566 mismatches, all ≤ 1 minor unit.
  - Resolution path:
    - Reproduce legacy behaviour in a golden-vector test suite
      - 640 vectors extracted from three years of production reversals
      - 71 vectors currently failing, all in the `XAU`/`XAG` metal-account class
        - Root cause suspected in the four-decimal instrument scaling table
        - Owner: Teodor Vlasak; ETA 2024-10-23
    - Obtain Risk & Controls written sign-off on the reproduced behaviour
    - Backfill 18 months of reversal history under the corrected rule
- **CMR-318 — Timestamp skew on same-second commits** *(fixed)*
  - 344 mismatches; resolved by widening the temporal tolerance to 2 s with documented justification.
- **CMR-322 — Dropped `entity_class` on inherited sub-accounts** *(fixed)*
  - 18 mismatches; a null-propagation bug in the projection builder.

### 4.3 Platform Work

- Migrated the log from six-hour to fifteen-minute compaction intervals, halving storage per million events.
- Replaced the per-event config look
