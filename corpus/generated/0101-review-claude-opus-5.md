# Review Summary: *Meridian Sync Service — Design Document v0.9*

**Reviewer:** Priya Ostrander, Platform Reliability
**Author:** Dane Kovalchuk, Data Services
**Date reviewed:** 14 March, cycle 27
**Verdict:** *Approve with changes* — no blocking defects, but three sections need rework before implementation kickoff.

---

## Overview

The document proposes a bidirectional replication layer between the Harbor ledger store and the downstream Cormorant analytics warehouse, targeting a 45-second freshness budget at the 95th percentile. The architecture is coherent and the failure taxonomy in §4 is unusually thorough. My concerns center on the conflict-resolution policy, the absence of a rollback narrative, and cost figures that appear to assume best-case compression.

## Findings

1. **Conflict resolution is underspecified.** §5.2 states that last-writer-wins is applied per record, but the ledger emits composite events where two subfields can legitimately be updated by different producers within the same millisecond. Without field-level vector clocks, we will silently drop ==roughly 0.3% of concurrent edits==, which exceeds the correctness bar the team agreed to in the Q1 charter.
2. **Backpressure path is missing.** The diagram on page 11 shows an unbounded in-memory queue between the change reader and the transform pool. Under a replay of the 8 February incident volume (~2.1M events in 90 seconds), the worker would exhaust its 6 GiB allocation in under two minutes.
3. **Cost model is optimistic.** The projected $4,180/month assumes a 6.4:1 compression ratio on the staging tier. Our observed ratio on comparable payloads is closer to 3.1:1, which pushes the estimate to roughly **$7,900/month**.
4. **Observability is adequate but flat.** Counters are proposed for throughput and error rate; there is no latency histogram, so we cannot verify the freshness SLO the document itself sets.
5. **Security review is deferred**, which is *acceptable at this stage* but should be explicitly scheduled rather than left as a footnote.

Suggested shape for the missing histogram registration:

```python
from metrics import Histogram, Registry

sync_lag = Histogram(
    name="meridian_sync_lag_seconds",
    buckets=(0.5, 1, 2, 5, 10, 20, 45, 90, 180),
    labels=("shard", "direction"),
)

def record_lag(shard: str, direction: str, emitted_at: float, applied_at: float) -> None:
    if applied_at < emitted_at:          # clock skew guard
        return
    sync_lag.observe(applied_at - emitted_at, shard=shard, direction=direction)

Registry.default().attach(sync_lag)
```

## Open Questions

- Who owns the reconciliation job when a shard is quarantined — the sync service or the on-call ledger team?
- Does the 45-second budget include the warehouse's own 12-second micro-batch window, or is it measured at ingest?
- Is schema evolution expected to be forward-compatible only, or must we support reading records written by a *newer* producer?
- What is the retention period for the dead-letter bucket? The document says "sufficient," which is not a number.

## Recommended Changes

- [x] Add latency histogram with the bucket set above
- [x] Replace the unbounded queue with a bounded channel plus a documented shed policy
- [ ] Introduce field-level versioning for composite ledger events
- [ ] Re-derive the cost table using the measured 3.1:1 ratio
- [ ] Add a §9 covering rollback: how a half-migrated shard returns to single-writer mode
- [ ] Schedule the security review and name a date
- [ ] Define dead-letter retention explicitly (I suggest **30 days**)

## Next Steps

Please resubmit as v0.10 by 28 March. I am happy to pair on the conflict-resolution section — that is the only item I consider genuinely hard, and it is worth two hours of whiteboard time before anyone writes code.
