# Review Summary: *Kestrel Ingest Pipeline — Design Specification v0.4*

**Reviewer:** M. Adeyemi-Vosk
**Date:** 14 March 2031
**Verdict:** Revise and resubmit

---

## Findings

- **Architecture**
  - The three-stage split (collect → normalize → fan-out) is sound and matches the throughput target of 42,000 events/second.
  - Backpressure handling is underspecified.
    - Section 4.2 names a bounded queue but never states its depth.
      - Suggested default: 8,192 records, with a documented spill-to-disk path.
      - Failure semantics on spill exhaustion are absent entirely.
- **Data model**
  - Field `origin_shard` is typed as a 16-bit integer, but the shard table in Appendix C lists 94,000 shards.
  - Timestamps mix epoch milliseconds and ISO-8601 strings across three tables.
- **Operations**
  - No rollback procedure for a failed schema migration.
  - Alert thresholds (page at 3% error rate) seem high given the stated 99.95% availability commitment.

## Questions

1. Is the normalizer expected to be idempotent across retries, or is deduplication delegated to the sink?
2. What is the retention window for the dead-letter store — the text implies 30 days, but the cost model assumes 7?
3. Who owns key rotation for the transport credentials: the platform team or each publishing service?

## Recommended Changes

Replace the ambiguous retry stanza in §5.1 with an explicit policy, e.g.:

```yaml
retry:
  strategy: exponential
  base_delay_ms: 250
  max_delay_ms: 30000
  max_attempts: 6
  jitter: full
  dead_letter:
    topic: kestrel.dlq.v1
    retention_days: 30
```

Additional items:

- Widen `origin_shard` to a 32-bit unsigned integer and regenerate Appendix C.
- Standardize on epoch microseconds (UTC) throughout; add a conversion note for legacy consumers.
- Add a section 9 covering migration rollback, including a tested downgrade script.
- Lower the paging threshold to 0.8% and add a warning tier at 0.3%.
- Include a load-test appendix with results at 1×, 2×, and 5× projected peak.

**Estimated rework:** 9–12 engineer-days before a second review pass.
