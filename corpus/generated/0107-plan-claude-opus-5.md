# Project Harbor Lantern — Billing Platform Modernization

**Document owner:** Dalia Wrenholt, Program Director
**Version:** 0.9 (draft for steering review)
**Last updated:** 14 March 2026

---

## 1. Purpose

Harbor Lantern replaces the legacy *Fernwick* invoicing engine with a modular, event-driven billing service. The current system processes roughly **41,000 invoices per night** and has exceeded its maintenance envelope: 63% of engineering hours in Q4 were spent on patching rather than delivery. Our target is a phased cutover that ends with ==zero unplanned billing outages during the December peak==.

> The steering committee's guidance from the 2 March session was unambiguous: *correctness before speed, and no dual-write period longer than six weeks.* Everything in this plan is shaped by that constraint.

---

## 2. Phases and Milestones

### Phase 0 — Discovery and Baseline (4 weeks)

**Owner:** Priya Sandoval-Reyes, Principal Analyst

- [x] Inventory all 87 downstream consumers of the Fernwick export feed
- [x] Publish reconciliation baseline (invoice totals, tax buckets, credit memos)
- [x] Confirm data retention obligations with Legal — **seven years**, unchanged
- [ ] Sign off on the canonical billing event schema

**Milestone M0.1:** *Baseline Report* accepted by Finance Operations — **10 April 2026**.

### Phase 1 — Core Ledger Build (9 weeks)

**Owner:** Tobias Alkhoury, Engineering Lead

The ledger is the irreversible part of the system, so it ships first and alone.

- Ledger service
  - Write path
    - Idempotency keys derived from `(tenant_id, cycle_id, line_hash)`
    - Append-only journal with hourly checkpoints
      - Checkpoint verification job runs at :07 past the hour
      - Divergence alerts route to the *Lantern-Sev2* channel
  - Read path
    - Materialized balance views refreshed every 90 seconds
    - Historical queries served from cold storage after 18 months

**Milestone M1.1:** Ledger passes 30-day shadow replay with **≤ 0.001%** variance — **19 June 2026**.
**Milestone M1.2:** Load test sustains 2,400 events/second for four hours — **26 June 2026**.

### Phase 2 — Rating and Tax Integration (7 weeks)

**Owner:** Marguerite Oyelaran, Solutions Architect

Rating rules move out of stored procedures and into a versioned rules repository. Tax calculation is delegated to the external *Verrin* service with a local fallback table.

```python
def rate_line_item(line, ruleset, fallback_tax_table):
    """Return a priced line, annotated with the ruleset version used."""
    base = ruleset.price(line.sku, line.quantity, line.tier)
    try:
        tax = verrin_client.quote(line.jurisdiction, base, timeout=1.5)
    except VerrinTimeout:
        tax = fallback_tax_table.lookup(line.jurisdiction) * base
        line.flags.append("TAX_FALLBACK")
    return PricedLine(
        base=base,
        tax=tax,
        total=round(base + tax, 2),
        ruleset_version=ruleset.version,
    )
```

**Milestone M2.1:** Rules repository holds all 412 migrated pricing rules — **7 August 2026**.
**Milestone M2.2:** Tax parity test suite green across 19 jurisdictions — **21 August 2026**.

### Phase 3 — Dual-Run and Reconciliation (6 weeks)

**Owner:** Priya Sandoval-Reyes

Both engines run against production input. Fernwick remains authoritative; Harbor Lantern output is compared, never sent.

- [x] Dual-run harness deployed to staging
- [ ] Week-one variance review with Finance Operations
- [ ] Automated diff report delivered daily by 06:30
- [ ] Variance below 0.005% for three consecutive cycles

**Milestone M3.1:** *Reconciliation Sign-Off* — **9 October 2026**.

### Phase 4 — Cutover and Decommission (5 weeks)

**Owner:** Dalia Wrenholt

Cutover sequence, executed in order:

1. Freeze Fernwick rule changes (T-10 days)
2. Migrate the pilot cohort — 6 tenants, ~900 invoices
3. Hold for one full billing cycle; publish the variance memo
4. Migrate remaining tenants in three waves of roughly equal volume
5. Switch the export feed to Harbor Lantern as the system of record
6. Place Fernwick in read-only mode for 120 days, then archive

**Milestone M4.1:** Pilot cohort billed from Harbor Lantern — **6 November 2026**.
**Milestone M4.2:** Full cutover complete — **4 December 2026**.
**Milestone M4.3:** Fernwick decommissioned — **2 April 2027**.

---

## 3. Owners at a Glance

| Area | Owner | Escalation |
|---|---|---|
| Program | Dalia Wrenholt | Steering Committee |
| Ledger & platform | Tobias Alkhoury | Dalia Wrenholt |
| Rating & tax | Marguerite Oyelaran | Tobias Alkhoury |
| Data & reconciliation | Priya Sandoval-Reyes | Dalia Wrenholt |
| Finance acceptance | Corin Vasquez-Bell | CFO delegate |
| Release engineering | Anselm Riddoch | Tobias Alkhoury |

---

## 4. Risks

| ID | Risk | Likelihood | Impact | Response | Owner |
|---|---|---|---|---|---|
| R-01 | Undocumented Fernwick rules surface during dual-run | High | High | Reserve 15% of Phase 3 capacity for rule discovery | Marguerite Oyelaran |
| R-02 | Verrin tax API latency breaches the 1.5s budget | Medium | Medium | Fallback table plus nightly true-up job | Marguerite Oyelaran |
| R-03 | Cutover collides with December peak volume | Medium | **Critical** | Hard stop: no migrations after 12 December | Dalia Wrenholt |
| R-04 | Finance reviewer availability during reconciliation | High | Medium | Named backup reviewer per wave, agreed in writing | Corin Vasquez-Bell |
| R-05 | Ledger checkpoint job falls behind under load | Low | High | Backpressure on ingest, alert at 3-checkpoint lag | Tobias Alkhoury |

*Risks are re-scored every second Thursday.* Any item reaching **Critical** impact with **High** likelihood triggers an immediate steering session within 48 hours, regardless of the standing calendar.
