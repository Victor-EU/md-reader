# Project Tideline — Replatforming the Kestrel Freight Billing Engine

**Document owner:** Marisol Achterberg, Director of Platform Delivery
**Version:** 1.4 (draft for steering committee review)
**Last updated:** 14 March 2026
**Status:** Approved for Phase 1 funding; Phases 2–4 pending gate review

---

## 1. Executive Summary

Kestrel Freight Systems currently invoices roughly 41,000 shipments per business day through *Ledgerhawk*, a monolithic billing engine first deployed in 2011. Ledgerhawk runs on two aging application servers in the Fairmont Road data centre, shares a single Oracle schema with the dispatch system, and requires a four-hour maintenance freeze every Sunday. In the last twelve months it has produced 312 billing exceptions requiring manual credit memos, and the average time to add a new surcharge rule is 26 business days.

Project Tideline will decompose Ledgerhawk into three deployable services — **Rating**, **Invoicing**, and **Settlement** — running on the Meridian container platform, backed by a dedicated PostgreSQL cluster and an event log built on Kafka topics. The target is a 90% reduction in manual credit memos, a rule-change lead time of under three business days, and elimination of the Sunday freeze.

The programme runs **6 April 2026 to 19 February 2027** (46 weeks) with a capital budget of **$3.85M** and a peak team size of 19 FTE.

---

## 2. Objectives and Success Metrics

| # | Objective | Metric | Baseline | Target |
|---|---|---|---|---|
| O1 | Reduce billing exceptions | Manual credit memos / month | 26 | ≤ 3 |
| O2 | Accelerate rule delivery | Median lead time for a surcharge rule | 26 days | ≤ 3 days |
| O3 | Remove scheduled downtime | Planned outage minutes / quarter | 3,120 | 0 |
| O4 | Improve invoice accuracy | First-pass invoice acceptance rate | 94.1% | ≥ 99.2% |
| O5 | Control run cost | Cost per 10,000 invoices | $118 | ≤ $76 |
| O6 | Decouple from dispatch | Cross-schema queries in production | 87 | 0 |

Success is declared when O1–O4 hold for two consecutive month-end closes after full cutover, and O5–O6 are verified by the Architecture Review Board.

---

## 3. Scope

### In scope

1. Extraction of rating, invoicing, and settlement logic from Ledgerhawk into three services.
2. A new rules authoring console for the Revenue Operations team.
3. Migration of 9.4 years of historical invoice data (approximately 38.2M rows) into the Tideline archive store.
4. Replacement of the nightly SFTP batch feed to the Harborline accounting suite with a streaming adapter.
5. Parallel-run tooling capable of comparing legacy and new invoices line-by-line.
6. Decommissioning of the Ledgerhawk application tier and its two physical hosts.

### Out of scope

- Changes to the dispatch system's own user interface.
- Renegotiation of customer tariff contracts (owned by Commercial, tracked separately as CR-2210).
- Multi-currency settlement beyond USD and CAD — deferred to a 2027 follow-on.
- Migration of the Pemberton subsidiary, which uses a separate billing stack.

---

## 4. Team and Ownership

| Role | Name | Accountability |
|---|---|---|
| Executive sponsor | Devrim Kaya, VP Revenue Systems | Funding, escalation, gate approvals |
| Programme manager | Marisol Achterberg | Plan, budget, reporting, risk register |
| Lead architect | Tobias Ferreira-Lund | Service boundaries, data model, ARB liaison |
| Rating service lead | Anaïs Bettencourt | Rating engine build and test |
| Invoicing service lead | Rohan Vaidyanathan | Invoicing, document generation |
| Settlement service lead | Priya Okonkwo-Reyes | Settlement, Harborline adapter |
| Data migration lead | Elias Strand | Historical load, reconciliation |
| QA manager | Hannah Cruz-Delgado | Test strategy, parallel-run verification |
| SRE lead | Marcus Oyelaran | Platform, observability, cutover runbook |
| Revenue Ops product owner | Fenella Tomczak | Rule catalogue, UAT sign-off |
| Security & compliance | Ingrid Halvorsen | SOC 2 evidence, PII handling, pen test |
| Change & training | Callum Devereux | Comms, training, hypercare readiness |

RACI detail lives in the programme workspace under `tideline/governance/raci-v3.xlsx`.

---

## 5. Phases and Milestones

### Phase 0 — Mobilisation (6 Apr – 1 May 2026, 4 weeks)

Establish the team, environments, and baselines. Confirm the service boundaries proposed in the December discovery spike.

- **Deliverables:** signed charter; environment blueprint; Ledgerhawk behaviour catalogue (target 240 documented rules); baseline performance profile.
- **Exit criteria:** ARB endorsement of the three-service decomposition; all 19 FTE onboarded with production-adjacent access.
- **Owner:** Marisol Achterberg
- **Milestone M0 — Charter signed and baselines published: 1 May 2026**

### Phase 1 — Foundation (4 May – 26 Jun 2026, 8 weeks)

Build the platform substrate before any business logic moves. Namespace provisioning, PostgreSQL cluster, Kafka topics, CI/CD pipelines, and the observability stack.

- **Deliverables:** three Meridian namespaces; `tideline-core` shared library; golden pipeline template; synthetic load harness producing 60,000 shipments/day.
- **Exit criteria:** a "hello billing" service deploys from commit to production-like in under 14 minutes with automated rollback.
- **Owner:** Marcus Oyelaran (with Tobias Ferreira-Lund)
- **Milestone M1 — Platform foundation accepted: 26 Jun 2026**

### Phase 2 — Rating Service (29 Jun – 25 Sep 2026, 13 weeks)

The highest-risk extraction. Rating holds the tariff logic, accessorial charges, fuel index interpolation, and the dimensional-weight rounding rules that generate most disputes.

- **Deliverables:** Rating service v1; rules authoring console (read-only in this phase); rule migration for all 240 catalogued rules; shadow-mode comparator.
- **Exit criteria:** shadow mode agrees with Ledgerhawk on ≥ 99.5% of rated shipments across a 21-day window; all disagreements triaged and classified.
- **Owner:** Anaïs Bettencourt
- **Milestone M2a — Rating service in shadow mode: 21 Aug 2026**
- **Milestone M2b — Rating parity gate passed: 25 Sep 2026**

### Phase 3 — Invoicing and Settlement (28 Sep 2026 – 8 Jan 2027, 15 weeks)

Two services built in parallel by separate squads, sharing the event log defined in Phase 1.

- **Deliverables:** Invoicing service with PDF and EDI 210 output; Settlement service; Harborline streaming adapter; rules console write-enabled; historical data migration complete.
- **Exit criteria:** month-end close for November and December 2026 reproduced in the parallel environment with zero material variance (materiality threshold: $250 per customer per month).
- **Owners:** Rohan Vaidyanathan, Priya Okonkwo-Reyes, Elias Strand
- **Milestone M3a — Harborline adapter certified by Finance: 20 Nov 2026**
- **Milestone M3b — Historical archive loaded and reconciled: 11 Dec 2026**
- **Milestone M3c — Two clean parallel closes: 8 Jan 2027**

### Phase 4 — Cutover and Hypercare (11 Jan – 19 Feb 2027, 6 weeks)

Progressive migration by customer cohort rather than big-bang. Four cohorts: internal test accounts (12), small shippers (1,840), mid-market (410), and the eleven strategic accounts representing 38% of revenue.

- **Deliverables:** cutover runbook v2; cohort migration; Ledgerhawk read-only freeze; decommission plan.
- **Exit criteria:** 100% of invoicing on Tideline for 14 consecutive days; zero Severity-1 incidents in the final 10 days; Ledgerhawk hosts powered down.
- **Owner:** Marcus Oyelaran (cutover), Callum Devereux (hypercare)
- **Milestone M4a — Cohort 1 and 2 live: 22 Jan 2027**
- **Milestone M4b — All cohorts live: 5 Feb 2027**
- **Milestone M4c — Ledgerhawk decommissioned, project closed: 19 Feb 2027**

---

## 6. Current Sprint Board (Sprint 2, ending 1 May 2026)

- [x] Publish Ledgerhawk behaviour catalogue, sections 1–4 (Bettencourt)
- [x] Provision `tideline-dev` and `tideline-stage` namespaces (Oyelaran)
- [x] Agree materiality threshold with Finance (Achterberg / Tomczak)
- [x] Draft data classification for the 38.2M-row archive (Halvorsen)
- [ ] Complete behaviour catalogue sections 5–7, including accessorials (Bettencourt)
- [ ] Sign the Kafka capacity addendum with the Meridian platform
