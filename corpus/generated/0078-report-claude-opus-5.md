# Project Halyard — Status Report

**Reporting period:** March 3 – March 28, 2025
**Prepared by:** Dana Ferreira-Voss, Engineering Program Lead
**Distribution:** Platform Steering Group, Reliability Guild, Finance Partner (K. Ojo)
**Overall status:** 🟡 *Amber — on track for the June cutover, with two dependencies requiring executive attention*

---

## 1. Executive Summary

Project Halyard is the eighteen-month effort to migrate our order-fulfilment estate from the legacy `Marlin` monolith to the event-driven `Tidewater` services platform. This period covered the completion of Phase 3 (dual-write shadow traffic) and the opening of Phase 4 (progressive read cutover).

The headline result: **we ran 100% of production write traffic through the shadow path for eleven consecutive days with a divergence rate of 0.014%**, comfortably under our 0.05% gate. Read cutover began March 24 at 5% of traffic in the `eu-west` region and has since expanded to 22% without a customer-visible incident.

Two items are dragging the status to amber. First, the *Ledger Reconciliation Service* (LRS) upgrade owned by the Finance Platform team has slipped by three weeks, which compresses our integration window from four weeks to nine days. Second, p99 latency on the `fulfilment.reserve` endpoint remains at 412 ms against a target of 300 ms, and the current mitigation plan carries meaningful schedule risk.

Neither issue currently threatens the June 16 cutover date, but both would if they slip another two weeks.

---

## 2. Metrics Dashboard

### 2.1 Migration Progress

| Workstream | Target (EOM) | Actual | Delta | Trend |
|---|---:|---:|---:|:--:|
| Endpoints migrated | 88 | 91 | +3 | ▲ |
| Write traffic on shadow path | 100% | 100% | — | ● |
| Read traffic cut over | 15% | 22% | +7 | ▲ |
| Legacy tables decommissioned | 34 | 27 | −7 | ▼ |
| Runbooks rewritten | 42 | 44 | +2 | ▲ |
| Consumers migrated off `Marlin` SDK | 19 | 14 | −5 | ▼ |

Table decommissioning is behind because we discovered nine tables still receiving writes from an undocumented batch job (`nightly-truer`, owned by the Merchandising team). That job is now instrumented and scheduled for retirement on April 11.

### 2.2 Reliability & Performance

| Metric | Baseline (Jan) | Target | Current | Status |
|---|---:|---:|---:|:--:|
| p50 latency, `fulfilment.reserve` | 118 ms | 90 ms | 84 ms | ✅ |
| p99 latency, `fulfilment.reserve` | 640 ms | 300 ms | 412 ms | ⚠️ |
| p99 latency, `catalog.lookup` | 210 ms | 150 ms | 133 ms | ✅ |
| Error budget consumed (30d) | — | ≤ 40% | 31% | ✅ |
| Shadow divergence rate | 1.9% | ≤ 0.05% | 0.014% | ✅ |
| Mean time to detect (MTTD) | 14 min | ≤ 5 min | 4.2 min | ✅ |
| Mean time to recovery (MTTR) | 71 min | ≤ 30 min | 38 min | ⚠️ |
| Change failure rate | 12.4% | ≤ 8% | 6.1% | ✅ |

### 2.3 Cost & Capacity

Steady-state infrastructure spend for the Tidewater estate landed at **$47,300/month**, against a forecast of $52,000. The saving comes almost entirely from right-sizing the `reserve-worker` fleet after the March 12 profiling exercise — we dropped from 96 to 61 instances with no throughput regression.

Projected combined run cost during the dual-running period (April–June) is $91,800/month, peaking in May. Post-decommission steady state is forecast at $44,000/month, a **34% reduction** against the legacy baseline of $66,900.

---

## 3. Detailed Progress

### 3.1 Shadow Traffic Results

The eleven-day soak produced 214 million shadowed write operations. Of those, 29,960 diverged. We categorised every divergence:

- **61%** — timestamp precision differences (legacy truncates to seconds; Tidewater stores microseconds). Cosmetic; accepted and documented.
- **24%** — ordering differences in the `line_items` array where the legacy system sorted by insertion and Tidewater sorts by SKU. Downstream consumers confirmed order-insensitive; accepted.
- **11%** — genuine logic divergence in the partial-refund path when a refund crosses a fiscal period boundary. **Fixed in release `tw-4.11.2`.**
- **4%** — transient, attributable to two shadow-comparator outages on March 9 and March 17.

The partial-refund bug was the most valuable find of the phase. It would have produced incorrect ledger entries for roughly 300 orders per month, and it existed only because the legacy code path had an undocumented behaviour introduced in 2019.

### 3.2 Read Cutover Mechanics

Read cutover is governed by a weighted router keyed on a stable hash of the tenant ID, so a given tenant sees consistent behaviour rather than flapping between backends. The rollout controller polls four signals every thirty seconds and halts automatically on breach.

```python
# halyard/rollout/controller.py — cutover guard evaluation
from dataclasses import dataclass

GATES = {
    "error_rate":       0.0035,   # fraction of 5xx responses
    "p99_latency_ms":   500.0,
    "divergence_rate":  0.0005,
    "queue_depth":      12_000,
}

@dataclass(frozen=True)
class Sample:
    error_rate: float
    p99_latency_ms: float
    divergence_rate: float
    queue_depth: int


def evaluate(sample: Sample, current_weight: float) -> tuple[float, str]:
    """Return the next traffic weight and a human-readable reason."""
    breaches = [
        name for name, limit in GATES.items()
        if getattr(sample, name) > limit
    ]

    if breaches:
        return 0.0, f"HALT: gate breach on {', '.join(sorted(breaches))}"

    if current_weight >= 1.0:
        return 1.0, "cutover complete; holding at full weight"

    headroom = min(
        (GATES["p99_latency_ms"] - sample.p99_latency_ms) / GATES["p99_latency_ms"],
        1.0,
    )
    step = 0.05 if headroom > 0.30 else 0.02
    next_weight = round(min(current_weight + step, 1.0), 4)
    return next_weight, f"advance to {next_weight:.0%} (headroom {headroom:.0%})"
```

The controller has triggered one automatic halt, on March 26 at 14:07 UTC, when queue depth on `reserve-events` spiked to 18,400 after a consumer deployment stalled. Traffic returned to zero within nineteen seconds, the consumer was rolled back, and we resumed at the prior weight ninety minutes later. **No customer-facing errors were recorded.** This is exactly the behaviour we designed for and it materially increased the team's confidence in pushing to higher weights.

### 3.3 The p99 Latency Problem

The `fulfilment.reserve` tail latency is the most stubborn technical issue in the project. Profiling on March 12 and again on March 25 points to a single cause: *serialised inventory lock acquisition across warehouse partitions*. When an order spans four or more partitions — about 6% of orders, but heavily weighted toward our largest merchants — we acquire locks one at a time with a 40 ms median round trip each.

Three options are on the table:

1. **Parallel lock acquisition with deadlock detection.** Estimated 3 weeks, brings p99 to ~240 ms. Highest complexity; introduces a new failure mode we would need to soak for two weeks.
2. **Optimistic reservation with compensating release.** Estimated 2 weeks, brings p99 to ~280 ms. Requires changes to the compensation saga and a conversation with Finance about transient over-reservation.
3. **Partition-affinity routing for large merchants.** Estimated 1 week, brings p99 to ~330 ms — *above target*. A partial fix, but shippable before cutover.

The team's recommendation is ==option 2, with option 3 pre-built as a fallback that can be enabled by feature flag if option 2 misses its date==. A decision is requested from the Steering Group by **April 4**.

---

## 4. Risks & Dependencies

| ID | Risk | Likelihood | Impact | Owner | Mitigation |
|---|---|:--:|:--:|---|---|
| R-07 | LRS upgrade slips beyond April 18 | Medium | High | P. Anand (Finance Platform) | Escalated; requesting a dedicated integration engineer for two weeks |
| R-11 | p99 fix not delivered before cutover | Medium | Medium | J. Kwon | Fallback option 3 pre-built behind flag |
| R-14 | `nightly-truer` retirement blocked by Merchandising roadmap | Low | Medium | S. Ilves | Alternative: read-only replica shim, 4 days of work |
| R-19 | Key-person dependency on Tidewater router internals | High | Medium | D. Ferreira-Voss | Pairing rotation started March 19; two engineers now onboarded |
| R-22 | June cutover collides with peak-season code freeze | Low | High | Steering Group | Confirm freeze dates at April board review |

R-07 is the one requiring executive action. The Finance Platform team has three competing commitments and has been transparent that Halyard is currently ranked third. *Without a re-prioritisation, we lose our buffer entirely.*

---

## 5. Next Steps

**By April 4**
- Steering Group decision on the p99 mitigation option (Ferreira-Voss to circulate a one-page decision brief on April 1).
- Complete read cutover to 40% in `eu-west`; begin 5% in `us-east`.
- Publish the divergence taxonomy document to the internal wiki for Reliability Guild review.

**By April 11**
- Retire `nightly-truer`; decommission the nine blocked legacy tables.
- Land the chosen p99 fix in staging with a 72-hour soak.
- Migrate five remaining internal consumers off the `Marlin` SDK (currently 14 of 19 complete).

**By April 25**
- LRS integration window opens; complete contract testing against the upgraded ledger API.
- Read traffic at 100% in `eu-west`, 50% in `us-east`, 25% in `ap-south`.
- Dry-run the cutover runbook with the on-call rotation, including a deliberate rollback rehearsal.

**By May 9**
- Freeze new feature work on `Marlin`; all changes routed to Tidewater.
- Final capacity review and cost forecast refresh for the Finance Partner.
- Begin drafting the decommissioning plan for the legacy estate (target: September).

---

*Next report: April 25, 2025. Questions or corrections to the program mailbox before April 2, please.*
