# Project Halyard — Status Report

**Reporting period:** March 3 – March 28, 2025
**Prepared by:** Dana Okonkwo, Engineering Lead, Platform Reliability
**Distribution:** Steering committee, SRE guild, Partner Integrations

---

## 1. Executive Summary

Project Halyard is the migration of our event ingestion pipeline from the legacy `bluefin` cluster to the sharded `halyard-core` architecture. The goal is to cut tail latency, remove the single-writer bottleneck in the dedupe stage, and give partner teams a stable contract for replaying historical events.

This period we completed the **shadow-traffic phase** for all four ingestion regions and began a staged cutover in `eu-west-2`. Shadow results were better than our success criteria in three of four regions; `ap-south-1` remains a concern due to a checkpoint-compaction bug we discovered on March 19.

> The headline number: p99 ingest latency in shadow dropped from 812 ms to 214 ms, a 73.6% improvement. The headline risk: our compaction worker leaks file descriptors under sustained replay, and we have not yet reproduced it outside of `ap-south-1`.

We are **on schedule for the April 22 general cutover**, with one caveat described in Section 5.

---

## 2. Metrics

All figures are 7-day rolling medians unless noted, measured March 21–28 against the baseline captured February 10–17.

| Metric | Baseline | Current | Target | Status |
|---|---|---|---|---|
| p50 ingest latency | 96 ms | 41 ms | ≤ 60 ms | ✅ Met |
| p99 ingest latency | 812 ms | 214 ms | ≤ 300 ms | ✅ Met |
| Sustained throughput (events/sec) | 148,000 | 397,000 | ≥ 350,000 | ✅ Met |
| Duplicate rate (per million) | 41.2 | 3.7 | ≤ 5.0 | ✅ Met |
| Replay window | 72 h | 30 d | ≥ 14 d | ✅ Met |
| Cost per billion events | $214 | $166 | ≤ $180 | ✅ Met |
| Compaction worker uptime (`ap-south-1`) | 99.94% | 97.11% | ≥ 99.9% | ❌ Missed |
| Partner integration coverage | 0 / 19 | 12 / 19 | 19 / 19 | ⚠️ At risk |

Two notes on interpretation:

1. The throughput figure was measured under synthetic load at 2.4× peak organic traffic. *Organic peak in the period was 163,000 events/sec*, so we retain substantial headroom.
2. The cost improvement is partly an artifact of reserved-capacity pricing negotiated in January. Excluding that, the like-for-like improvement is closer to **$214 → $189**, which still clears target but by a thinner margin. ==We should not present the $166 figure externally without this caveat.==

---

## 3. What Shipped

- **Sharded dedupe stage.** Replaced the single-writer bloom index with 64 range-partitioned shards keyed on `(tenant_id, event_uuid)`. This removed the contention hotspot responsible for most of the old p99.
- **Replay API v2.** Partners can now request arbitrary time ranges up to 30 days with cursor-based pagination. Twelve partners have migrated.
- **Backpressure protocol.** Producers receive a structured `RETRY_AFTER` frame instead of a connection reset. Early data suggests this cut producer-side error logs by roughly 88%.
- **Observability pack.** Fourteen new dashboards, six SLO burn-rate alerts, and per-shard cardinality caps to stop the metrics bill from exploding.

Here is the backpressure decision function, which several teams have asked about:

```python
def compute_retry_after(queue_depth: int,
                        drain_rate: float,
                        shard_count: int = 64,
                        floor_ms: int = 25,
                        ceiling_ms: int = 30_000) -> int:
    """Return a retry delay in milliseconds for an overloaded shard.

    drain_rate is measured in events/sec for a single shard.
    We deliberately overestimate by 15% so producers back off
    slightly harder than strictly necessary, which damps oscillation.
    """
    if drain_rate <= 0:
        return ceiling_ms

    per_shard_depth = queue_depth / max(shard_count, 1)
    seconds_to_drain = per_shard_depth / drain_rate
    padded_ms = int(seconds_to_drain * 1000 * 1.15)

    return max(floor_ms, min(padded_ms, ceiling_ms))
```

The 15% padding factor was chosen empirically after a load test on March 11 showed that an unpadded value produced a three-minute oscillation cycle between saturation and idle.

---

## 4. Open Work

- [x] Complete shadow traffic in `us-east-1`, `us-west-2`, `eu-west-2`
- [x] Complete shadow traffic in `ap-south-1`
- [x] Ship Replay API v2 to general availability
- [x] Publish migration runbook (rev. 4)
- [x] Negotiate reserved-capacity pricing for FY26
- [ ] Fix compaction worker file-descriptor leak (**owner:** Priya Raman, **due:** April 4)
- [ ] Migrate remaining 7 partner integrations
- [ ] Load-test `ap-south-1` at 3× peak with compaction enabled
- [ ] Decommission `bluefin` read replicas
- [ ] Write the post-cutover rollback drill and run it once in staging
- [ ] Update the cost model with post-cutover actuals

---

## 5. Risks and Issues

**R-101 — Compaction file-descriptor leak (High).** Under sustained replay of more than approximately 4.1 million events, the compaction worker in `ap-south-1` accumulates open segment handles and eventually hits the process limit. The worker restarts cleanly, so there is no data loss, but each restart costs about 90 seconds of compaction lag. *We believe this is a missing `close()` on an error path in the segment reader*, but we have not reproduced it in staging, which makes us nervous about the diagnosis.

**R-104 — Partner migration tail (Medium).** Seven partners remain on Replay API v1. Three have confirmed April dates. Four have not responded to two outreach attempts. If they have not migrated by April 15, we will either extend v1 support by one quarter or force-migrate with a compatibility shim. ==Decision needed from the steering committee by April 8.==

**R-109 — Runbook drift (Low).** The migration runbook is at revision 4 and has changed materially twice since the team last rehearsed it. Scheduling a fresh drill.

---

## 6. Next Steps

| Date | Milestone | Owner |
|---|---|---|
| April 4 | Compaction leak fixed and verified | Priya Raman |
| April 8 | Steering decision on v1 sunset | Dana Okonkwo |
| April 11 | `ap-south-1` load test at 3× peak | Marcus Feld |
| April 15 | Rollback drill in staging | Wen Zhao |
| April 22 | General cutover, all regions | Dana Okonkwo |
| May 6 | `bluefin` decommission begins | Marcus Feld |

Our position going into April is that everything except the compaction leak is either finished or comfortably tracked. If the leak is not resolved by April 11, we will cut over three regions on schedule and hold `ap-south-1` on the legacy path for an additional two weeks. That split-mode operation is supported and tested, but it is *operationally unpleasant* and we would prefer to avoid it.

Questions or objections to the April 22 date should reach me by **April 9**.
