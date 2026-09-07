# Project Plan: Harbormaster Migration

**Document ID:** PP-2291-HRB
**Version:** 1.4
**Last revised:** 12 March
**Prepared by:** Delia Ravenscroft, Program Manager, Platform Services
**Approvers:** Terrence Oyelaran (VP Engineering), Nadia Kirchmann (Director, Data Operations)

---

## 1. Executive Summary

Harbormaster is the internal replacement for our aging order-routing service, Pelican. Pelican currently handles roughly 4.2 million routing decisions per day across eleven regional warehouses, but it runs on a monolithic Java 8 codebase with a single PostgreSQL 11 primary and no meaningful horizontal scaling story. Over the last two quarters we recorded 31 production incidents attributable to Pelican, of which nine were Sev-2 or higher.

Harbormaster decomposes routing into three services — **Intake**, **Scoring**, and **Dispatch** — backed by an event log and a read-optimized projection store. The migration is a phased cutover using dual-write and shadow-read techniques so that we never require a hard flag-day switch.

**Target completion:** 14 November
**Budget envelope:** $1.86M (engineering time, infrastructure, and vendor licensing)
**Headcount:** 14 FTE at peak, drawn from four teams

---

## 2. Goals and Non-Goals

### Goals

1. Reduce p99 routing latency from 840 ms to under 220 ms.
2. Support 12,000 routing decisions per second sustained, with burst capacity to 20,000.
3. Eliminate the single-primary database as a failure point.
4. Give warehouse operations a self-service interface for routing rule changes (currently a five-day ticket cycle).
5. Retire Pelican entirely, including its two cron sidecars and the `pelican-admin` console.

### Non-Goals

- Rewriting the inventory reservation subsystem (tracked separately as PP-2310).
- Changing the carrier integration contracts. Harbormaster speaks the same downstream protocol.
- Multi-region active-active. We remain active-passive with a documented 22-minute RTO.

---

## 3. Phases

### Phase 0 — Foundations (complete)

**Window:** 6 January – 7 February
**Owner:** Marcus Deveraux (Staff Engineer, Platform)

Established the shared infrastructure: Kafka cluster `hbr-events-prod` with 24 partitions per topic, the Terraform module set, CI pipelines, and the observability baseline (traces into Lightkeeper, metrics into our Prometheus federation).

Exit criteria met on 5 February, two days early. The only carryover was the load-testing harness, which slipped into Phase 1 because the synthetic order generator needed a rewrite when we discovered the sample dataset had been anonymized in a way that destroyed the geographic distribution.

### Phase 1 — Intake Service and Shadow Traffic

**Window:** 10 February – 28 March
**Owner:** Priya Sundaravel (Tech Lead, Order Systems)

Build the Intake service, which accepts routing requests, validates them, normalizes address data, and publishes to the event log. Intake runs in shadow mode: it receives a mirrored copy of production traffic from Pelican's ingress, processes it fully, and discards the output while recording divergences.

The divergence detector compares Intake's normalized output against Pelican's for every mirrored request. Our acceptance bar is a divergence rate under 0.05% across a rolling seven-day window, excluding a known-and-accepted list of address-formatting differences in Quebec and Puerto Rico.

### Phase 2 — Scoring Engine

**Window:** 17 March – 30 May
**Owner:** Bo Hallenbeck (Principal Engineer, Optimization)

The Scoring service is the technically hardest component. It evaluates candidate warehouse-carrier pairs against a weighted cost model incorporating distance, capacity utilization, SLA risk, and negotiated carrier rates. Pelican's scoring logic lives in a 6,400-line class with no test coverage; a substantial part of Phase 2 is archaeology.

We are reimplementing scoring as a rule DAG with explicit inputs, which makes the logic testable and lets operations modify weights without a deploy.

```python
# scoring/dag.py — excerpt from the rule evaluation core
from dataclasses import dataclass
from typing import Callable, Iterable

@dataclass(frozen=True)
class Candidate:
    warehouse_id: str
    carrier_code: str
    transit_days: int
    unit_cost_cents: int
    capacity_headroom: float  # 0.0 (full) to 1.0 (empty)

@dataclass(frozen=True)
class Rule:
    name: str
    weight: float
    evaluate: Callable[[Candidate], float]  # returns 0.0–1.0

def score(candidate: Candidate, rules: Iterable[Rule]) -> float:
    total_weight = 0.0
    accumulated = 0.0
    for rule in rules:
        raw = rule.evaluate(candidate)
        if not 0.0 <= raw <= 1.0:
            raise ValueError(f"rule {rule.name} returned {raw}, out of range")
        accumulated += raw * rule.weight
        total_weight += rule.weight
    return accumulated / total_weight if total_weight else 0.0

RULESET_V3 = [
    Rule("transit_speed", 0.35, lambda c: max(0.0, 1.0 - (c.transit_days / 7))),
    Rule("cost_efficiency", 0.30, lambda c: max(0.0, 1.0 - (c.unit_cost_cents / 4200))),
    Rule("capacity_safety", 0.25, lambda c: c.capacity_headroom),
    Rule("carrier_reliability", 0.10, lambda c: CARRIER_SCORES.get(c.carrier_code, 0.5)),
]
```

Phase 2 includes a parity campaign: replay 90 days of historical routing decisions through both engines and reconcile. Target agreement is 99.3% on final warehouse selection; disagreements must be individually explained and categorized.

### Phase 3 — Dispatch and Dual-Write

**Window:** 12 May – 25 July
**Owner:** Ingrid Solheim (Senior Engineer, Fulfillment Integration)

Dispatch consumes scoring decisions and emits carrier bookings. During this phase, both Pelican and Harbormaster write to the downstream booking system, with Harbormaster's writes tagged as provisional and reconciled by an audit job that runs every 15 minutes.

This phase carries the highest blast radius. A duplicate booking is a real financial event — approximately $34 in wasted carrier commitment per occurrence — so dual-write is gated behind a per-warehouse feature flag and starts with our smallest facility (Terrace Falls, ~9,000 orders/day).

### Phase 4 — Progressive Cutover

**Window:** 28 July – 17 October
**Owner:** Delia Ravenscroft (Program Manager)

Warehouse-by-warehouse cutover in five waves. Each wave requires a 96-hour soak with clean metrics before the next begins. Rollback is a flag flip, verified by drill at the start of each wave.

| Wave | Warehouses | Daily volume | Start date |
|---|---|---|---|
| 1 | Terrace Falls | 9,000 | 28 July |
| 2 | Ashgrove, Bellamy Point | 141,000 | 11 August |
| 3 | Kestrel Junction, Mordant Hill, Vance | 612,000 | 1 September |
| 4 | Halloway, Piedmont North, Sable Creek | 1,480,000 | 22 September |
| 5 | Corvid Bay, Thornmere | 1,958,000 | 13 October |

### Phase 5 — Decommission

**Window:** 20 October – 14 November
**Owner:** Marcus Deveraux

Pelican goes read-only for 14 days, then its compute is destroyed and its database snapshotted to cold storage with a seven-year retention tag (finance requirement, ref FIN-4402). The `pelican-admin` console is removed from the internal portal and its DNS entry retired.

---

## 4. Milestones

- [x] **M1** — Foundations complete, event log live in production (5 February)
- [x] **M2** — Intake shadow traffic at 100% mirror rate (3 March)
- [x] **M3** — Divergence rate below 0.05% sustained for seven days (21 March)
- [ ] **M4** — Scoring parity campaign passes 99.3% agreement (target 16 May)
- [ ] **M5** — Dual-write enabled at Terrace Falls with zero duplicate bookings over 10 days (target 27 June)
- [ ] **M6** — Wave 3 cutover complete (target 12 September)
- [ ] **M7** — All eleven warehouses on Harbormaster (target 17 October)
- [ ] **M8** — Pelican decommissioned, cost savings realized (target 14 November)

---

## 5. Ownership Matrix

| Area | Primary owner | Backup | Escalation |
|---|---|---|---|
| Program coordination | Delia Ravenscroft | Aurelio Banks | Terrence Oyelaran |
| Intake service | Priya Sundaravel | Kwame Otieno | Terrence Oyelaran |
| Scoring engine | Bo Hallenbeck | Yuki Tashiro | Terrence Oyelaran |
| Dispatch integration | Ingrid Solheim | Ramona Feld | Nadia Kirchmann |
| Infrastructure & CI | Marcus Deveraux | Solene Abara | Nadia Kirchmann |
| Data migration | Yuki Tashiro | Marcus Deveraux | Nadia Kirchmann |
| Ops readiness & runbooks | Ramona Feld | Delia Ravenscroft | Nadia Kirchmann |
| Warehouse liaison | Aurelio Banks | — | Terrence Oyelaran |

---

## 6. Risks

**R-01 — Scoring logic archaeology exceeds estimate.**
*Likelihood: High. Impact: High.*
Pelican's scoring class has no tests and at least three code paths that appear dead but may not be. Mitigation: allocate 240 engineer-hours explicitly for reverse-engineering, and treat the 90-day replay as the source of truth rather than the source code. If parity stalls below 98%, we accept a documented behavior change with sign-off from Fulfillment Operations rather than chasing exact equivalence. Owner: Bo Hallenbeck.

**R-02 — Duplicate carrier bookings during dual-write.**
*Likelihood: Medium. Impact: High.*
Mitigation: provisional-write tagging, 15-minute reconciliation audit, per-warehouse flags, and a hard circuit breaker that disables Harbormaster dispatch if more than three duplicates occur in any 60-minute window. Owner: Ingrid Solheim.

**R-03 — Kafka partition hot-spotting under holiday load.**
*Likelihood: Medium. Impact: Medium.*
Our partition key is warehouse ID, and Corvid Bay alone is 26% of volume. Mitigation: composite key of warehouse ID plus order-hash bucket, tested at 20,000 decisions/second before Wave 5. Owner: Marcus Deveraux.

**R-04 — Wave 5 collides with
