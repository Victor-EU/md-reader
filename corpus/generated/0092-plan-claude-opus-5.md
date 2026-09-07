# Project Plan: Harbor Ledger Migration

**Project Code:** HLM-2291
**Sponsor:** Dalia Ferreiro, VP of Platform Operations
**Program Manager:** Tomas Elkjaer
**Planning Horizon:** March 3 – November 14
**Document Version:** 1.4 (draft for steering review)

---

## 1. Purpose and Scope

Harbor Ledger is the internal settlement system that reconciles partner payouts across our seven regional entities. It currently runs on a single-tenant Kestrel 4 database with a batch window that has grown from 40 minutes to just under three hours. This project migrates Harbor Ledger to the Tidewater event-streaming platform, splits the monolithic reconciliation job into six bounded services, and retires the legacy nightly batch entirely.

**In scope:** ledger ingestion, reconciliation engine, payout scheduling, partner-facing statement API, historical data backfill (36 months).

**Out of scope:** the tax withholding calculator (owned by Finance Systems), the partner onboarding portal, and any change to the general ledger chart of accounts.

> The success criterion is not "we moved the data." It is that a regional controller in Lisbon can close their books on the second business day without filing a single manual adjustment ticket. Everything else in this plan is instrumentation toward that outcome.
> — Dalia Ferreiro, kickoff memo, February 19

---

## 2. Phases

### Phase 0 — Discovery and Baseline (Mar 3 – Apr 11)

- Instrument the existing batch job to produce per-stage timing telemetry
- Catalogue all 214 downstream consumers of the `ledger_settle_v2` table
  - Classify each consumer by:
    - **Criticality**
      - Tier 1 — payout blocking (expected: 11 consumers)
      - Tier 2 — reporting, tolerant of 24h delay (expected: ~60)
      - Tier 3 — ad hoc analyst queries, deprecate where possible
    - **Migration path**
      - Direct rewire to Tidewater topic
      - Compatibility view maintained for two quarters
      - Sunset with 60-day notice
- Produce the reconciliation invariant catalogue (target: 48 documented invariants)

**Owner:** Priya Nandakumar (Staff Engineer, Ledger)
**Exit gate:** Baseline performance report signed off by Dalia Ferreiro and Marcus Ostroff (Head of Finance Systems).

### Phase 1 — Foundation Build (Apr 14 – Jun 20)

- Stand up Tidewater clusters in `eu-west-2` and `us-east-4` with cross-region replication
- Build the `ledger-ingest` and `ledger-normalize` services
- Implement the dual-write shim so legacy and new paths receive identical input
- Deliver the invariant test harness (runs all 48 invariants against both systems nightly)

**Owner:** Reuben Achterberg (Engineering Manager, Platform)

### Phase 2 — Reconciliation Engine (Jun 23 – Aug 29)

- Port matching logic for the four settlement types: standard, split-remit, chargeback reversal, FX-adjusted
- Build the exception queue and controller review UI
- Backfill 36 months of history into the new store (est. 1.9 TB compressed)
- Achieve 14 consecutive nights of zero-divergence between legacy and new outputs

**Owner:** Priya Nandakumar

### Phase 3 — Cutover and Stabilization (Sep 1 – Oct 24)

- Regional cutover in waves: Iberia → Nordics → North America → APAC
- Legacy batch runs in shadow mode for 21 days after each wave
- Decommission `ledger_settle_v2` writes; convert to read-only compatibility view

**Owner:** Ines Kovalenko (Release Manager)

### Phase 4 — Retirement and Handover (Oct 27 – Nov 14)

- Decommission Kestrel 4 instance `hl-prod-01`
- Transfer on-call ownership to the Ledger Reliability squad
- Publish runbooks, post-implementation review, and cost reconciliation

**Owner:** Tomas Elkjaer

---

## 3. Milestones

| ID | Milestone | Target Date | Owner | Gate Criteria |
|----|-----------|-------------|-------|---------------|
| M1 | Baseline report accepted | Apr 11 | P. Nandakumar | Telemetry live 14 days; consumer catalogue at 100% |
| M2 | Dual-write shim in production | May 30 | R. Achterberg | <0.5% write latency regression |
| M3 | Invariant harness green | Jun 20 | R. Achterberg | 48/48 invariants passing 7 nights |
| M4 | Backfill complete and verified | Aug 8 | P. Nandakumar | Row-count and checksum parity |
| M5 | Zero-divergence streak achieved | Aug 29 | P. Nandakumar | 14 consecutive nights |
| M6 | Iberia wave live | Sep 12 | I. Kovalenko | Controller sign-off, Lisbon + Madrid |
| M7 | All regions cut over | Oct 24 | I. Kovalenko | Shadow mode clean for all four waves |
| M8 | Kestrel 4 decommissioned | Nov 7 | T. Elkjaer | Final snapshot archived, 7-year retention |
| M9 | Project closed | Nov 14 | T. Elkjaer | PIR published, budget reconciled |

---

## 4. Verification Approach

Each nightly comparison run emits a divergence record. The stabilization gate is defined programmatically so there is no argument about "close enough":

```python
from datetime import date, timedelta

ACCEPTED_STREAK = 14
CENT_TOLERANCE = 0

def divergence_free(run):
    """A run passes only if every invariant holds and no cent is unexplained."""
    return (
        run.invariants_failed == 0
        and abs(run.legacy_total_cents - run.tidewater_total_cents) <= CENT_TOLERANCE
        and run.unmatched_records == 0
    )

def cutover_ready(runs, as_of: date) -> bool:
    window = [r for r in runs if as_of - r.run_date < timedelta(days=ACCEPTED_STREAK)]
    if len(window) < ACCEPTED_STREAK:
        return False
    return all(divergence_free(r) for r in window)
```

Results post to the `#hlm-nightly` channel at 06:15 UTC. Two consecutive failures automatically pause the cutover calendar and page the phase owner.

---

## 5. Risks

| ID | Risk | Likelihood | Impact | Owner | Mitigation |
|----|------|-----------|--------|-------|------------|
| R1 | FX-adjusted settlements have undocumented rounding behaviour in legacy code | High | High | P. Nandakumar | Dedicate two engineers to a rounding archaeology spike in Phase 0; capture as invariants 31–39 |
| R2 | Backfill exceeds the 1.9 TB estimate and blows the storage budget | Medium | Medium | R. Achterberg | Reserve 3.4 TB; compress Tier 3 history at lower fidelity |
| R3 | Regional controllers unavailable during APAC wave (fiscal year-end) | Medium | High | I. Kovalenko | Move APAC to the final wave; secure named deputies by Aug 1 |
| R4 | Tidewater cross-region replication lag exceeds 90 seconds under peak load | Low | High | R. Achterberg | Load test at 3x peak in Phase 1; fallback to single-region writes with async mirror |
| R5 | Key-person dependency on Priya Nandakumar for reconciliation logic | High | Medium | T. Elkjaer | Pair rotation from Phase 1; mandatory design docs for each settlement type |
| R6 | Tier 3 consumers resist sunset and escalate | Medium | Low | M. Ostroff | 60-day notice issued Apr 15; compatibility view offered as compromise |

---

## 6. Governance

- **Steering committee:** meets fortnightly, Thursdays 14:00 UTC (Ferreiro, Ostroff, Elkjaer, Achterberg)
- **Phase gate reviews:** held within three business days of each phase end date
- **Escalation path:** phase owner → Elkjaer → Ferreiro; anything touching payout correctness escalates immediately and skips intermediate steps
- **Budget:** 1,240 engineering days approved; 9% contingency held by Elkjaer, released only at gate reviews
