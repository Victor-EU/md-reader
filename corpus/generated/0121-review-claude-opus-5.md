# Review Summary — *Draft Specification v0.4: Harbor Telemetry Pipeline*

**Reviewer:** Delia Marchetti-Okonjo
**Date:** 14 March 2026
**Document owner:** Ravi Thornquist, Platform Reliability

---

## Findings

The draft is substantially clearer than v0.3, and the new sequence diagrams in §4 resolve most of the ambiguity previously flagged around retry semantics. Three issues remain material.

1. **Backpressure is underspecified.** §5.2 states that the collector "sheds load," but never defines the threshold, the shedding order, or whether shed events are themselves recorded. Given the stated ingest ceiling of 48,000 events/second, this is ==the single highest-risk gap in the document==.
2. *Retention arithmetic does not reconcile.* Appendix B assumes 90-day hot storage at 2.1 TB/day, which yields 189 TB, but the capacity table lists 140 TB. Either the compression ratio (claimed 3.4:1) or the retention window is wrong.
3. **Schema versioning is mentioned once and never elaborated.** There is no migration story for consumers pinned to v1 envelopes.

A representative config fragment from §6 illustrates the second concern:

```yaml
retention:
  hot_days: 90
  warm_days: 275
  compression_ratio: 3.4
  provisioned_tb: 140
```

## Questions

- Does "shed" mean *drop*, *sample*, or *divert to cold buffer*? These have very different downstream contracts.
- Who owns the dead-letter queue after handoff to the Kestrel team in Q3?
- Is the 12 ms p99 target measured at the collector edge or after enrichment?

## Recommended Changes

- [x] Add sequence diagrams for the retry path (done in v0.4)
- [x] Define the envelope field `trace_origin`
- [ ] Specify backpressure thresholds and shedding policy in §5.2
- [ ] Reconcile the retention arithmetic in Appendix B
- [ ] Add a schema migration section, including a deprecation window of at least **two quarters**
- [ ] Clarify measurement point for latency SLOs

**Recommendation:** *Approve with changes.* I expect one further review cycle; please re-circulate by 28 March.
