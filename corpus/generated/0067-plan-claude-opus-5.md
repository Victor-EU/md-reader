# Project Harbor Lantern — Billing Engine Modernization

**Document owner:** Priya Vandekamp, Director of Platform Engineering
**Version:** 2.3 (draft)
**Last revised:** 14 March, fiscal year 27
**Distribution:** Steering Committee, Engineering Leads, Finance Operations

---

## 1. Purpose and Scope

Harbor Lantern replaces the legacy invoicing subsystem (internally codenamed *Tinbox*) with a metered, event-driven billing engine capable of handling 4.2 million line items per day. The current system caps out at roughly 900,000 line items and requires a nightly batch window of five hours and forty minutes, which blocks same-day invoice corrections for our enterprise tier.

**In scope:** invoice generation, proration logic, tax adapter integration, customer-facing statement PDFs, and the reconciliation feed to the general ledger.

**Out of scope:** payment capture, dunning workflows, the partner commission calculator, and anything touching the Meridian data warehouse. Those remain with the Revenue Systems group under a separate charter.

---

## 2. Phases and Milestones

### Phase 0 — Discovery and Baseline (6 weeks)
**Owner:** Dez Okonkwo, Principal Analyst

Establish a measured baseline for throughput, error rates, and reconciliation drift. Produce a mapping document covering all 214 legacy proration rules, flagging the 31 rules that Finance believes are obsolete.

- **M0.1** — Baseline throughput report signed off by Finance Ops
- **M0.2** — Rule inventory published with obsolescence recommendations
- **M0.3** — Architecture decision record approved by the Design Council

### Phase 1 — Core Engine Build (14 weeks)
**Owner:** Marisol Quist, Engineering Manager, Billing Core

Construct the calculation kernel, the event ingestion pipeline, and the idempotency layer. Run in shadow mode against production traffic without emitting customer-visible artifacts.

- **M1.1** — Kernel passes the 1,850-case golden regression suite
- **M1.2** — Shadow mode achieves 99.94% parity with Tinbox over 14 consecutive days
- **M1.3** — Load test sustains 6,000 line items per second for four hours

### Phase 2 — Integration and Statement Rendering (9 weeks)
**Owner:** Bram Hollisay, Staff Engineer

Wire in the tax adapter, the ledger feed, and the PDF rendering service. Finance validates statement layouts across the eleven supported locales.

- **M2.1** — Tax adapter certified against the Kestrel compliance harness
- **M2.2** — Locale rendering approved by Finance and Legal
- **M2.3** — Ledger reconciliation drift below 0.02% for one full close cycle

### Phase 3 — Cutover and Stabilization (7 weeks)
**Owner:** Priya Vandekamp

Migrate customers in four waves, monitor, then decommission Tinbox.

- **M3.1** — Wave A (internal test accounts, 40 tenants) complete
- **M3.2** — Wave D (all remaining 12,700 tenants) complete
- **M3.3** — Tinbox read-only; decommission ticket filed

---

## 3. Cutover Wave Structure

- **Wave A — Internal**
  - Tenant profile: synthetic and employee accounts
    - Validation depth: full manual audit
      - Reviewers: two Finance analysts plus one engineer
      - Rollback trigger: any single mismatched invoice
- **Wave B — Small Business**
  - Tenant profile: monthly flat-rate plans, under $500 monthly recurring
    - Validation depth: 10% sample audit
      - Reviewers: automated diff tool, spot-checked weekly
      - Rollback trigger: mismatch rate above 0.5%
- **Wave C — Mid-Market**
  - Tenant profile: metered usage, multi-currency
    - Validation depth: 25% sample audit
      - Reviewers: Finance Ops queue, 48-hour SLA
      - Rollback trigger: mismatch rate above 0.1%, or any tax miscalculation
- **Wave D — Enterprise and Remainder**
  - Tenant profile: negotiated contracts, custom proration
    - Validation depth: full audit for the top 60 accounts by revenue
      - Reviewers: named account managers plus Controller sign-off
      - Rollback trigger: any Controller objection

---

## 4. Current Sprint Task List

- [x] Freeze the legacy rule inventory at revision 41
- [x] Provision the shadow-mode Kafka topic (`hl.invoice.shadow.v2`)
- [x] Draft the idempotency key specification
- [ ] Backfill 90 days of usage events into the staging cluster
- [ ] Implement the mid-cycle plan-change proration path
- [ ] Wire the tax adapter timeout circuit breaker
- [x] Publish the parity dashboard to the Finance Ops workspace
- [ ] Schedule the Wave B tenant communication

---

## 5. Parity Check Configuration

```yaml
parity:
  window_days: 14
  tolerance:
    line_item_cents: 0
    invoice_total_cents: 1
    tax_total_cents: 0
  sampling:
    wave_a: 1.00
    wave_b: 0.10
    wave_c: 0.25
    wave_d: 0.40
  alerting:
    channel: "#harbor-lantern-parity"
    escalate_after_failures: 3
    pager_rotation: billing-core-primary
  exclusions:
    - reason: "credit memo backdating"
      expires: "FY27-Q3"
```

---

## 6. Risk Register

| ID | Risk | Likelihood | Impact | Owner | Mitigation |
|----|------|-----------|--------|-------|------------|
| R-01 | Proration rules undocumented in Tinbox source | High | High | Dez Okonkwo | Shadow-mode diffing surfaces gaps before cutover |
| R-02 | Tax adapter vendor misses its April delivery | Medium | High | Bram Hollisay | Contractual penalty clause; fallback to in-house table for six locales |
| R-03 | Finance close calendar collides with Wave C | Medium | Medium | Priya Vandekamp | Waves scheduled only in the second week of each month |
| R-04 | Key engineer attrition on Billing Core | Low | High | Marisol Quist | Pair rotation; no single-owner components |
| R-05 | PDF renderer memory pressure at peak | Medium | Low | Bram Hollisay | Horizontal autoscaling, tested to 9x baseline |

---

## 7. Escalation Path

1. Engineering lead attempts resolution within one business day.
2. Unresolved items go to the weekly Harbor Lantern sync (Wednesdays, 10:15).
3. Cross-team blockers escalate to Priya Vandekamp within 48 hours.
4. Anything threatening a milestone date goes to the Steering Committee at the next Thursday review.
5. Cutover rollbacks require a written note to the Controller within four hours.
