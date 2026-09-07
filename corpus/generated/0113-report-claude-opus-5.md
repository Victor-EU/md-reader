# Project Nimbus Relay — Status Report

**Reporting period:** March 3 – March 14, 2026
**Prepared by:** Dalia Okonkwo, Engineering Lead
**Distribution:** Platform Guild, Reliability Council, Finance Ops

---

## 1. Summary

Nimbus Relay replaces our legacy message fan-out service (Kestrel) with a partitioned, backpressure-aware relay built on an internal streaming runtime. The goal is to cut tail latency for downstream notification consumers and remove the single-writer bottleneck that has caused four Sev-2 incidents since October.

We are **on track for the April 9 production cutover**, though the schema-registry integration slipped four working days after we discovered incompatible enum handling in the v2 serializer.

> The migration is no longer a throughput problem. It is a correctness problem wearing a throughput costume. Every remaining risk we have logged traces back to how the two systems disagree about what a "delivered" event means.
> — Retro note from the March 11 working session

---

## 2. Metrics

| Metric | Baseline (Kestrel) | Current (Relay, staging) | Target |
|---|---|---|---|
| p50 fan-out latency | 84 ms | 21 ms | ≤ 30 ms |
| p99 fan-out latency | 2,410 ms | 288 ms | ≤ 400 ms |
| Sustained throughput | 11.2k msg/s | 47.6k msg/s | ≥ 40k msg/s |
| Duplicate delivery rate | 0.42% | 0.019% | ≤ 0.05% |
| Consumer lag (peak) | 96 s | 7 s | ≤ 15 s |
| Test coverage (relay core) | — | 81% | ≥ 85% |
| Open Sev-3+ defects | — | 6 | ≤ 2 at cutover |
| Projected monthly infra cost | $18,300 | $12,940 | ≤ $15,000 |

Shadow traffic has been running at 35% of production volume for nine days with no data-loss events. The two duplicate-delivery spikes on March 6 and March 9 both correlate with partition rebalances triggered by node preemption in the `relay-east-2` pool.

---

## 3. Verification snippet

The reconciliation job below is what we run nightly to compare emitted event IDs between systems:

```python
def reconcile(window_start, window_end, tolerance=0.0005):
    legacy = fetch_ids("kestrel", window_start, window_end)
    relay = fetch_ids("nimbus_relay", window_start, window_end)

    missing = legacy - relay
    extra = relay - legacy
    drift = (len(missing) + len(extra)) / max(len(legacy), 1)

    return {
        "window": (window_start, window_end),
        "missing_count": len(missing),
        "extra_count": len(extra),
        "drift_ratio": round(drift, 6),
        "passing": drift <= tolerance,
    }
```

Last seven nightly runs: six passing, one failure (drift 0.0011 on March 9, attributed to the rebalance issue above).

---

## 4. Next steps

- [x] Complete partitioned writer implementation
- [x] Stand up shadow traffic at 25% and 35%
- [x] Publish consumer migration guide to the Platform Guild wiki
- [x] Load test to 45k msg/s sustained for two hours
- [ ] Pin node pool to non-preemptible instances for `relay-east-2`
- [ ] Resolve enum widening bug in the v2 serializer (owner: Marcus Idrissi, due Mar 19)
- [ ] Raise relay core coverage from 81% to 85%
- [ ] Dry-run cutover with the Payments and Alerts consumers (Mar 25)
- [ ] Finalize rollback runbook and get Reliability Council sign-off
- [ ] Decommission Kestrel writer nodes (post-cutover, April 23)

---

## 5. Risks

1. **Serializer bug (High).** Blocks two of nine consumers. Mitigation in review.
2. **Preemption-driven rebalances (Medium).** Fix is a configuration change; requires a $640/month cost increase, pending Finance Ops approval.
3. **Consumer readiness (Medium).** Three teams have not yet confirmed a migration date. Escalating at the March 18 guild sync.

**Next report:** March 28, 2026.
