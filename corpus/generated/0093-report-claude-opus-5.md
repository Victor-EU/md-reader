# Project Halyard — Status Report

**Reporting period:** March 3 – March 28, 2025
**Prepared by:** Dana Okonkwo, Engineering Lead
**Distribution:** Platform Steering Group, SRE Guild, Product (Ingest)
**Status:** 🟡 Amber — on track for scope, one week behind on schedule

---

## 1. Executive Summary

Project Halyard replaces the legacy `feedmill` ingestion pipeline with a streaming architecture built on partitioned event logs and a stateless transform tier. The goal is to cut end-to-end ingest latency for partner telemetry from minutes to seconds while reducing per-event cost.

This period we completed the transform tier rewrite, shipped the new schema registry to staging, and ran the first full-volume shadow replay against production traffic. Results were encouraging: p95 latency landed at 840 ms against a target of 1,200 ms. However, the cutover date slips by one week because the dead-letter reprocessing path is not yet idempotent, and we will not migrate partner traffic without it.

> The shadow replay told us more in six hours than four weeks of synthetic load testing did. We are keeping shadow mode running permanently as a regression net, not just as a migration tool.

---

## 2. Metrics

| Metric | Baseline (legacy) | Target | Current | Trend |
|---|---|---|---|---|
| p50 end-to-end latency | 41 s | 400 ms | 210 ms | ▼ improving |
| p95 end-to-end latency | 186 s | 1,200 ms | 840 ms | ▼ improving |
| p99 end-to-end latency | 512 s | 3,000 ms | 4,150 ms | ▲ regressed |
| Events processed / day | 1.9 B | — | 2.1 B (shadow) | flat |
| Cost per million events | $0.94 | $0.40 | $0.51 | ▼ improving |
| Schema validation failures | 0.31% | < 0.05% | 0.08% | ▼ improving |
| Transform tier CPU util. (avg) | — | 55–70% | 62% | stable |
| Unit + integration coverage | 44% | 80% | 73% | ▲ improving |
| Open Sev-2 defects | — | 0 | 3 | flat |

**Note on p99:** the regression is caused by a single partner (`corvid-metrics`) sending 14 MB batched payloads that stall a shard for roughly four seconds. Mitigation is payload chunking at the edge, scheduled for sprint 19.

---

## 3. Work Completed

- [x] Transform tier rewritten in Rust; `feedmill-compat` shim removed
- [x] Schema registry v2 deployed to staging with backward-compat checks
- [x] Shadow replay harness built and run against 6 hours of production traffic
- [x] Partition rebalancing automation (`halyard-balancer`) merged
- [x] Runbook drafted for cutover and rollback
- [x] Cost dashboard wired into the finance data mart
- [ ] Idempotent dead-letter reprocessing
- [ ] Edge payload chunking for oversized batches
- [ ] Partner-facing migration notices (drafted, awaiting legal review)
- [ ] Load test at 3× peak volume
- [ ] Decommission plan for legacy `feedmill` workers

---

## 4. Technical Detail: Dead-Letter Idempotency

The current reprocessor re-emits failed events without a stable deduplication key, so a retried batch can produce duplicate downstream rows. The fix introduces a deterministic key derived from the source offset and a content digest.

```rust
use blake3::Hasher;

/// Builds a stable dedup key so replayed events collapse downstream.
pub fn dedup_key(partition: u16, offset: u64, payload: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(&partition.to_be_bytes());
    hasher.update(&offset.to_be_bytes());
    hasher.update(payload);
    let digest = hasher.finalize();
    format!("hly-{partition:04x}-{offset:016x}-{}", &digest.to_hex()[..16])
}

#[cfg(test)]
mod tests {
    use super::dedup_key;

    #[test]
    fn key_is_stable_across_calls() {
        let a = dedup_key(7, 90_112, b"{\"sensor\":\"t-14\"}");
        let b = dedup_key(7, 90_112, b"{\"sensor\":\"t-14\"}");
        assert_eq!(a, b);
        assert!(a.starts_with("hly-0007-"));
    }
}
```

The sink will enforce uniqueness on this key with a 72-hour rolling window, which covers our maximum retry horizon with margin.

---

## 5. Risks and Issues

1. **Dead-letter idempotency (High).** Blocks cutover entirely. Owner: Priya Ramachandran. Fix in review, merge expected April 2.
2. **Oversized partner payloads (Medium).** Drives the p99 regression. Owner: Tomas Berglund. Requires a coordinated change with the edge collector team.
3. **Schema registry single-writer bottleneck (Medium).** Registry writes serialize through one node; fine at current volume, but projected to saturate at roughly 4× traffic. Owner: unassigned — needs staffing decision.
4. **Legacy decommission dependency (Low).** Two internal reporting jobs still read directly from `feedmill` tables. Owner: Ana Ruiz-Delgado, tracked separately in the Analytics backlog.

---

## 6. Next Steps

1. Merge and deploy idempotent dead-letter reprocessing to staging (April 2).
2. Run 72-hour soak test with deliberate failure injection at 5% event loss (April 3–6).
3. Ship edge payload chunking and re-measure p99 (April 9).
4. Complete 3× peak load test and publish capacity model (April 11).
5. Send partner migration notices with a 10-business-day window (April 14).
6. Begin phased traffic cutover at 5% → 25% → 100% (April 21–30).
7. Freeze legacy writes and start the 30-day decommission clock (May 5).

---

## 7. Asks

- **Staffing:** one backend engineer for four weeks to address the registry bottleneck before it becomes urgent.
- **Decision needed by April 4:** whether to retain the legacy pipeline in warm standby for 30 or 90 days post-cutover. Warm standby costs approximately $3,100 per month.
- **Review:** SRE Guild sign-off on the cutover runbook, requested by April 8.
