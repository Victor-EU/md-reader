# Project Halyard — Billing Engine Modernization

**Program sponsor:** Renata Volkov, VP of Revenue Systems
**Project manager:** Desmond Achebe-Lyle
**Document version:** 2.4 (revised 14 March)
**Status:** ==Approved for execution — Phase 2 in progress==

---

## 1. Executive Summary

Nordwell Freight Systems currently invoices roughly **41,000 shipments per month** through *Cormorant*, a batch billing engine written in 2009 and maintained by a shrinking pool of three engineers. Cormorant cannot price multi-leg intermodal moves, cannot issue partial credits, and requires an eleven-hour overnight run that regularly overshoots the 04:00 cutoff for the treasury feed.

Project Halyard replaces Cormorant with **Tidewater**, an event-driven rating and invoicing service built in-house, over a fourteen-month window. The target outcomes are a rating latency under 900 milliseconds at the 95th percentile, a reduction in manual invoice corrections from 6.2% to below 1.5%, and full retirement of the Cormorant mainframe partition by the end of Q1 next year.

> Our measure of success is not that Tidewater launches. It is that the finance close team stops scheduling weekend shifts in month three of every quarter. Everything else in this plan is instrumental to that.
> — Renata Volkov, kickoff remarks

Total approved budget is **$3.85M**, of which $2.31M is internal labor, $940K is vendor and licensing, and $600K is a contingency reserve released only by the steering committee.

---

## 2. Scope

### In scope

- Rating engine for line-haul, drayage, accessorial, and fuel surcharge products
- Invoice generation, consolidation, and PDF/EDI 210 output
- Credit, rebill, and dispute workflows
- Migration of 7.4 years of historical invoice data (approximately 3.1 billion rows)
- Read-only reporting parity with the twenty-two reports finance uses today

### Out of scope

- Accounts receivable collections tooling (owned by Project Windlass)
- Customer self-service portal redesign
- Tax determination logic, which remains with the *Argent* third-party service
- Any change to the general ledger chart of accounts

---

## 3. Phases and Milestones

### Phase 0 — Discovery and Baseline *(complete)*

**Owner:** Priya Nandakumar, Principal Analyst
**Duration:** 6 weeks | **Actual cost:** $214K against a $190K estimate

Deliverables were a rating rules inventory, a data profile of the Cormorant tables, and a signed non-functional requirements document. Discovery surfaced **1,847 distinct pricing rules**, of which 612 had not fired in eighteen months and were flagged for retirement rather than migration.

| Milestone | Target | Actual | Owner |
|---|---|---|---|
| M0.1 Rules inventory signed | 12 Jan | 12 Jan | Nandakumar |
| M0.2 NFR baseline approved | 26 Jan | 02 Feb | Achebe-Lyle |
| M0.3 Steering gate 0 | 30 Jan | 06 Feb | Volkov |

### Phase 1 — Architecture and Foundations *(complete)*

**Owner:** Tomas Bergqvist, Chief Architect
**Duration:** 10 weeks | **Actual cost:** $488K

Established the Tidewater service skeleton, the event schema registry, and the parallel-run harness that replays production shipments against both engines. The harness is the single most important asset produced in this phase — every subsequent validation milestone depends on it.

```yaml
# tidewater/config/parallel-run.yaml
harness:
  name: cormorant-shadow
  sample_rate: 1.0          # replay 100% of production traffic
  divergence_threshold_bps: 5
  quarantine_on_divergence: true
  outputs:
    - sink: s3://nfs-halyard-divergence/daily/
      format: parquet
    - sink: kafka://rating.divergence.v2
      partition_key: shipment_id
alerting:
  page_when:
    consecutive_failed_batches: 2
    divergence_rate_pct_gt: 0.35
  channel: "#halyard-oncall"
retention_days: 400
```

### Phase 2 — Core Rating Build *(in progress, 63% complete)*

**Owner:** Aiko Ferrand-Marsh, Engineering Manager
**Duration:** 20 weeks | **Budget:** $1.02M

The team of nine engineers is porting the 1,235 surviving pricing rules in four thematic waves. Wave 1 (line-haul) and Wave 2 (accessorials) have passed parallel-run validation at a divergence rate of 0.11%, comfortably inside the 0.35% tolerance. Wave 3 (fuel surcharge indexing) is the hardest, because the legacy code contains an undocumented rounding behavior that finance has been silently reconciling against for years.

**Current sprint checklist:**

- [x] Wave 1 line-haul rules ported and validated
- [x] Wave 2 accessorial rules ported and validated
- [x] Divergence dashboard published to finance stakeholders
- [x] Rounding-behavior spike completed and documented
- [ ] Wave 3 fuel surcharge indexing (14 of 63 rules remaining)
- [ ] Wave 4 intermodal multi-leg splitting
- [ ] Load test at 3× peak volume sustained for 90 minutes
- [ ] Security review with the Ridgeline assessment team

| Milestone | Target | Owner |
|---|---|---|
| M2.1 Wave 1 validated | 18 Feb ✅ | Ferrand-Marsh |
| M2.2 Wave 2 validated | 09 Mar ✅ | Ferrand-Marsh |
| M2.3 Wave 3 validated | 11 Apr | Ferrand-Marsh |
| M2.4 Wave 4 validated | 23 May | Bergqvist |
| M2.5 Steering gate 2 | 30 May | Volkov |

### Phase 3 — Data Migration

**Owner:** Colin Sayeda-Brandt, Data Engineering Lead
**Duration:** 12 weeks | **Budget:** $610K

Historical invoice data moves in three tranches, oldest first, using a checksum-per-partition reconciliation. Tranche 1 covers years 6–7.4 and is deliberately low-risk to prove the tooling. *No tranche is considered migrated until finance signs a reconciliation certificate for it.*

1. Build extraction jobs and partition checksum tooling (weeks 1–3)
2. Tranche 1 dry run into the staging cluster (weeks 4–5)
3. Tranche 1 production load and reconciliation (weeks 6–7)
4. Tranche 2 production load and reconciliation (weeks 8–9)
5. Tranche 3 production load, including the hot 18-month window (weeks 10–11)
6. Freeze, final delta sync, and migration sign-off (week 12)

### Phase 4 — Pilot and Controlled Rollout

**Owner:** Marguerite Oyelaran, Director of Billing Operations
**Duration:** 10 weeks | **Budget:** $445K

Tidewater becomes the system of record for a widening slice of the customer book while Cormorant continues to run in shadow mode. The ramp is **5% → 20% → 50% → 100%**, with a mandatory seven-day soak and a documented rollback decision at each step. Pilot cohort selection favors mid-size shippers with straightforward accessorial profiles; the eleven largest accounts move last.

| Milestone | Target | Owner |
|---|---|---|
| M4.1 5% cohort live | 08 Sep | Oyelaran |
| M4.2 50% cohort live | 20 Oct | Oyelaran |
| M4.3 100% cutover | 17 Nov | Achebe-Lyle |
| M4.4 Steering gate 4 | 21 Nov | Volkov |

### Phase 5 — Decommission and Hypercare

**Owner:** Desmond Achebe-Lyle
**Duration:** 8 weeks | **Budget:** $332K

Thirty days of hypercare with a dedicated rotation, then progressive shutdown of Cormorant: batch schedules disabled, mainframe partition released, and licenses terminated. The final milestone, **M5.3 Cormorant partition released (12 Feb)**, unlocks an annualized $780K infrastructure saving that has already been committed in next year's operating plan.

---

## 4. Governance

Steering committee meets fortnightly on Thursdays at 09:30. Gate decisions require Volkov plus two of three functional directors. Working-level status is published every Friday to `#halyard-status`; escalations follow a two-hour acknowledgment SLA during business hours.

---

## 5. Risk Register

| ID | Risk | Prob. | Impact | Score | Owner | Mitigation |
|---|---|---|---|---|---|---|
| R-01 | Fuel surcharge rounding cannot be reproduced exactly, causing customer-visible variances | High | High | 20 | Ferrand-Marsh | Codify legacy rounding as an explicit compatibility mode; finance approves a ±$0.02 per-invoice tolerance |
| R-02 | Tranche 3 migration exceeds the 36-hour freeze window | Medium | High | 15 | Sayeda-Brandt | Pre-stage 90% via incremental sync; freeze covers deltas only |
| R-03 | Key-person dependency on the two remaining Cormorant maintainers | Medium | High | 15 | Achebe-Lyle | Retention agreements through March; mandatory pair-documentation sessions weekly |
| R-04 | Argent tax service contract renegotiation slips past cutover | Low | High | 10 | Volkov | Legal engaged in January; 90-day extension clause already exercised |
| R-05 | Load test reveals the event bus cannot sustain 3× peak | Medium | Medium | 9 | Bergqvist | Partition rebalancing spike budgeted; fallback to batched writes |
| R-06 | Pilot customers reject invoice PDF layout changes | Medium | Low | 6 | Oyelaran | Layout held pixel-identical for phase 4; redesign deferred |
| R-07 | Contingency reserve consumed before Phase 4 | Low | Medium | 6 | Achebe-Lyle | Reserve draws require gate approval; monthly burn review |

**Top risk this period is R-01.** The spike concluded that legacy rounding applies half-up at the leg level and half-even at the invoice level, an inconsistency that will be preserved rather than corrected. Correcting it would shift approximately $18,400 per month in aggregate billing and require customer notification — a change deliberately deferred to a separate initiative after Halyard closes.
