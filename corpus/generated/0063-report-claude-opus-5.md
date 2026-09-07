# Project Halyard — Status Report

**Reporting period:** March 3 – March 14
**Prepared by:** Dana Vestergaard, Platform Engineering
**Status:** ==At risk — schedule slip of 4 working days==

---

## Summary

Halyard is the replacement ingestion pipeline for our telemetry backend, migrating from the legacy `sluice` collector to a streaming architecture built on partitioned queues. This sprint we completed the shadow-write phase for three of five tenant shards and began load validation against production-scale traffic.

The core throughput target has been met ahead of schedule. However, *schema drift detection* remains incomplete, and this is now the critical path item blocking the April 7 cutover.

> The shadow traffic results were better than we modeled, but the drift detector is catching roughly 1 in 900 events it shouldn't. Until that false-positive rate drops below 1 in 50,000, we cannot safely enable auto-quarantine in production.
> — Marcus Ohlin, Reliability Lead

## Key Metrics

| Metric | Baseline (legacy) | Target | Current |
|---|---|---|---|
| Sustained ingest rate | 42k events/sec | 120k events/sec | **147k events/sec** |
| p99 write latency | 810 ms | < 250 ms | 194 ms |
| Replay window | 6 hours | 72 hours | 72 hours |
| Drift false-positive rate | n/a | < 0.002% | 0.11% |
| Shards migrated | 0 / 5 | 5 / 5 | 3 / 5 |
| Cost per billion events | $61.40 | < $40.00 | $37.85 |

## Completed and Outstanding Work

- [x] Provision partitioned queue cluster in `eu-north` and `us-central`
- [x] Implement backpressure signaling between collector and writer tiers
- [x] Shadow-write validation for shards `alpha`, `bravo`, `charlie`
- [x] Cost modeling review with Finance (approved March 11)
- [ ] Reduce drift detector false-positive rate
  - [x] Instrument per-field mismatch counters
  - [ ] Rebuild type coercion table from live samples
  - [ ] Re-run 48-hour soak test
- [ ] Shadow-write validation for shards `delta`, `echo`
- [ ] Runbook handoff to on-call rotation

## Technical Detail: Drift Detector Fix

The current comparator treats a widened integer field as a breaking change. The revised logic classifies changes by compatibility tier before deciding whether to quarantine:

```python
COMPATIBLE_WIDENINGS = {
    ("int32", "int64"),
    ("float32", "float64"),
    ("string", "text"),
}

def classify(old_type, new_type):
    if old_type == new_type:
        return "identical"
    if (old_type, new_type) in COMPATIBLE_WIDENINGS:
        return "safe_widening"
    if new_type == "null":
        return "field_dropped"
    return "breaking"


def should_quarantine(old_type, new_type, strict=False):
    verdict = classify(old_type, new_type)
    if verdict == "breaking":
        return True
    return strict and verdict != "identical"
```

## Risks

- **Schedule risk — high.** The soak test cannot start until the coercion table is rebuilt, and the test itself consumes 48 hours of wall time.
  - Mitigation options:
    - Run an abbreviated 12-hour soak against synthetic traffic
      - Pros: unblocks `delta` migration immediately
      - Cons: *does not exercise the long-tail schema variants* we see on weekends
        - Historical data shows weekend traffic carries 3.2× the schema variance of weekdays
- **Staffing risk — medium.** Marcus is on leave March 24–28, overlapping the planned cutover rehearsal.

## Next Steps

1. Rebuild coercion table from a 7-day production sample — *owner: Priya Anand, due March 18*
2. Launch full soak test — *owner: Dana Vestergaard, due March 20*
3. Migrate shard `delta` under shadow-write — due March 24
4. Cutover rehearsal with rollback drill — due March 31
5. Production cutover — target **April 11** (revised from April 7)
