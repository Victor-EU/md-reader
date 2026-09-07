# Project Plan: Harborlight — Unified Billing Migration

**Project Code:** HRB-2201
**Sponsor:** Delia Marchetti, VP Revenue Systems
**Program Manager:** Toby Ekwueme
**Planning Horizon:** 14 March – 20 November
**Budget:** $1.42M (capital) + $310K (contingency)

## 1. Objective

Retire the legacy Ledgerbox invoicing stack and consolidate all recurring, usage-based, and one-time billing onto the internal Harborlight platform. Target outcomes: reduce monthly invoice error rate from 3.8% to under 0.4%, cut close time from nine days to three, and support multi-currency contracts in eleven markets.

## 2. Phases & Milestones

| Phase | Window | Milestone | Owner |
|---|---|---|---|
| P0 — Discovery | Mar 14 – Apr 25 | Signed data dictionary (v1.0) | Priya Ansbach |
| P1 — Architecture | Apr 28 – Jun 13 | Design review passed, 2 blockers max | Rowan Hædel |
| P2 — Build | Jun 16 – Sep 5 | Feature-complete in staging | Nils Okonkwo |
| P3 — Parallel Run | Sep 8 – Oct 17 | Six weeks at ≥99.6% reconciliation | Ines Kavuma |
| P4 — Cutover | Oct 20 – Nov 7 | Ledgerbox read-only | Toby Ekwueme |
| P5 — Stabilize | Nov 10 – Nov 20 | Hypercare exit, backlog < 12 tickets | Ines Kavuma |

## 3. Workstreams

- **Data Migration** — owner: Priya Ansbach
  - Historical extract (7 years, ~41M invoice lines)
    - Batch 1: FY19–FY21 archive
      - Checksum validation against vault snapshots
      - Redaction pass for closed EU accounts
    - Batch 2: FY22–present, incremental sync every 4 hours
  - Reference data cleanup
    - Tax jurisdiction mapping (Marisol Vent)
    - Duplicate customer merge — 2,140 candidate pairs
- **Platform Engineering** — owner: Rowan Hædel
  - Proration engine rewrite
  - Idempotent webhook delivery with 24-hour replay window
- **Finance Enablement** — owner: Gustav Fehr
  - Controller training (3 cohorts, 22 people)
  - Revised month-end runbook

## 4. Current Sprint Checklist

- [x] Approve data dictionary v1.0
- [x] Provision staging tenant `hrb-stg-02`
- [x] Baseline reconciliation report for March
- [ ] Finalize proration test matrix (owner: Nils Okonkwo, due Jun 27)
- [ ] Negotiate tax-service contract renewal
- [ ] Draft rollback runbook and dry-run it twice
- [ ] Sign off on hypercare staffing roster

## 5. Reconciliation Check

```python
def reconcile(legacy_rows, harbor_rows, tolerance_cents=2):
    mismatches = []
    harbor_index = {r["invoice_id"]: r for r in harbor_rows}
    for row in legacy_rows:
        target = harbor_index.get(row["invoice_id"])
        if target is None:
            mismatches.append((row["invoice_id"], "missing"))
            continue
        delta = abs(row["total_cents"] - target["total_cents"])
        if delta > tolerance_cents:
            mismatches.append((row["invoice_id"], f"delta={delta}"))
    coverage = 1 - len(mismatches) / max(len(legacy_rows), 1)
    return round(coverage, 5), mismatches
```

Gate: coverage must hold at ≥ 0.99600 for six consecutive weekly runs before cutover approval.

## 6. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Tax vendor API rate limits throttle backfill | Medium | High | Pre-purchase burst tier; stagger by region | Marisol Vent |
| R2 | Proration mismatches on mid-cycle upgrades | High | Medium | Freeze plan changes Oct 20–27 | Nils Okonkwo |
| R3 | Controller bandwidth during Q3 close | Medium | Medium | Contract two interim analysts | Gustav Fehr |
| R4 | Cutover overruns 72-hour window | Low | High | Rehearsed rollback; go/no-go at hour 36 | Toby Ekwueme |
| R5 | Undetected duplicate customers inflate invoices | Medium | High | Manual review of all merges above $5K ARR | Priya Ansbach |

## 7. Governance

Steering committee meets biweekly on Thursdays. Any milestone slipping more than five business days escalates to Delia Marchetti within 48 hours. Change requests above $25K require sponsor plus finance approval.
