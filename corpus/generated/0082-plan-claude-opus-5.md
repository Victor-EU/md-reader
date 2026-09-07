# Project Halyard — Customer Billing Platform Migration

**Document owner:** Priya Vantesh, Director of Platform Engineering
**Version:** 1.4 (draft) — approved for steering review
**Target completion:** 14 November 2026

## 1. Purpose

Halyard replaces the legacy Corvid billing engine with a modular, event-driven service layer capable of handling 4.2 million invoice events per day. The current system exceeds its throughput ceiling roughly nine days per month and requires 31 hours of manual reconciliation per billing cycle.

> The measure of success is not that we ship a new billing engine. It is that the finance team stops working weekends during close.
> — Dorian Ashgrove, VP Finance Operations, kickoff session

---

## 2. Phases and Milestones

| Phase | Window | Milestone | Owner |
|---|---|---|---|
| P0 — Discovery | Jan 5 – Feb 20 | Data lineage map for 187 tables signed off | Marla Feinstock |
| P1 — Architecture | Feb 23 – Apr 17 | Reference design + ADR set ratified | Priya Vantesh |
| P2 — Core Build | Apr 20 – Aug 7 | Invoice, proration, and tax services in staging | Tobias Reinke |
| P3 — Migration | Aug 10 – Oct 2 | 100% of 62,400 accounts dual-written | Chandra Balaji |
| P4 — Cutover | Oct 5 – Nov 14 | Corvid decommissioned, read-only archive | Priya Vantesh |

### Gate criteria for entering P4

1. Dual-write parity above 99.97% across three consecutive billing cycles.
2. Rollback rehearsal executed twice, each completing in under 22 minutes.
3. Finance sign-off on 40 sampled invoices spanning all six pricing models.
4. On-call rotation staffed with eight trained engineers, no single points of knowledge.
5. Zero open Severity-1 or Severity-2 defects; fewer than 12 open Severity-3.

---

## 3. Reconciliation Check

The nightly parity job compares Corvid output against Halyard output and flags drift above a half-cent threshold.

```python
def reconcile(legacy_rows, halyard_rows, tolerance_cents=0.5):
    drift = []
    index = {r.invoice_id: r for r in halyard_rows}
    for old in legacy_rows:
        new = index.get(old.invoice_id)
        if new is None:
            drift.append((old.invoice_id, "missing_in_halyard", old.total))
            continue
        delta = abs(old.total - new.total) * 100
        if delta > tolerance_cents:
            drift.append((old.invoice_id, "amount_mismatch", round(delta, 3)))
    parity = 1 - (len(drift) / max(len(legacy_rows), 1))
    return {"parity": round(parity, 6), "exceptions": drift[:250]}
```

---

## 4. Owners and Accountability

- **Priya Vantesh** — overall delivery, steering committee reporting, cutover call
- **Marla Feinstock** — data migration, lineage, archive strategy
- **Tobias Reinke** — service build, API contracts, performance budgets
- **Chandra Balaji** — dual-write orchestration, rollback tooling
- **Ines Karvalho** — QA strategy, 1,340-case regression suite
- **Dorian Ashgrove** — finance acceptance, external auditor liaison

## 5. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R-01 | Undocumented proration rules in Corvid stored procedures | High | High | Shadow-run 90 days of historical invoices before P3 | Marla Feinstock |
| R-02 | Tax vendor API rate limits during backfill | Medium | High | Negotiate temporary 5x quota; batch to 400 req/min | Tobias Reinke |
| R-03 | Finance team bandwidth during Q3 close | High | Medium | Freeze acceptance testing Aug 25 – Sep 5 | Dorian Ashgrove |
| R-04 | Key-person dependency on Corvid maintainer | Medium | High | Pair-programming rotation, recorded walkthroughs | Priya Vantesh |
| R-05 | Cutover window overruns 6-hour maintenance cap | Low | Critical | Two full rehearsals; abort trigger at minute 210 | Chandra Balaji |

## 6. Budget Envelope

Approved spend is $1.86M: $1.21M engineering, $340K vendor licensing, $190K contingency, $120K auditor fees. Variance above 8% escalates to the steering committee within five business days.
