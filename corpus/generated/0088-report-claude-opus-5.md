# Project Halyard — Status Report

**Reporting period:** Week 34 (Aug 18–24)
**Owner:** Priya Raghunathan, Platform Engineering
**Status:** 🟡 At risk (schedule), 🟢 On track (scope)

## Summary

Halyard is the replacement ingestion pipeline for our telemetry backend. This week we completed the shadow-traffic cutover for the `events-v2` topic and closed the last two blockers on schema validation. Latency targets are being met, but the backfill job is running roughly nine days behind plan due to throttling on the legacy datastore.

## Metrics

| Metric | Target | Current | Trend |
|---|---|---|---|
| p99 ingest latency | < 250 ms | 187 ms | ↓ 12% |
| Events/sec (peak) | 40,000 | 46,300 | ↑ |
| Schema rejection rate | < 0.5% | 0.31% | ↓ |
| Backfill completion | 60% | 38% | flat |
| Open Sev-2 defects | 0 | 3 | ↑ 1 |

## Architecture Notes

The validator now short-circuits on unknown envelope versions rather than throwing:

```python
def route(envelope):
    handler = HANDLERS.get(envelope.version)
    if handler is None:
        metrics.increment("halyard.envelope.unknown", tags=[envelope.version])
        return DeadLetter(reason="unsupported_version")
    return handler.process(envelope.payload)
```

## Workstreams

- **Ingest**
  - Shadow traffic
    - `events-v2` — complete
    - `events-v1` — complete
    - `audit-stream` — pending capacity review
      - Blocked on quota grant from Infra (ticket HAL-812)
      - Estimated unblock: Aug 29
  - Dead-letter replay tooling — in review
- **Storage**
  - Partition rebalance — complete
  - Retention policy rewrite — drafting
- **Observability**
  - Dashboards migrated to the new tracing backend

## Next Steps

1. Raise the legacy datastore read quota and restart the backfill with a larger parallelism factor (target: Aug 27).
2. Triage the three open Sev-2 defects; two appear to share a root cause in the retry decorator.
3. Ship dead-letter replay tooling to staging by Aug 30.
4. Schedule the production cutover readiness review for Sept 4.

## Risks

Backfill slippage may push the cutover into Sprint 19. A decision on partial cutover is needed by Aug 29.
