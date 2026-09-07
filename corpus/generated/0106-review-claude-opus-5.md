# Review Summary: *Draft Specification — Meridian Ingest Pipeline v2.3*

**Reviewer:** L. Okonkwo-Bertram, Platform Reliability
**Document owner:** Priya Vashisht, Data Services
**Revision reviewed:** `spec-meridian-ingest` rev. 14, dated 11 March
**Review window:** 12–19 March
**Overall disposition:** *Approve with revisions* — the architecture is sound, but three sections require substantive rework before this can go to the Architecture Board on 2 April.

---

## 1. Summary of Assessment

The draft describes a redesigned ingest path for telemetry arriving from field devices, replacing the current single-queue design with a partitioned fan-out and a deduplication layer backed by a rolling Bloom filter. The motivation section is persuasive: the current pipeline drops roughly **0.8%** of events during regional failover, and the proposed design targets a drop rate below **0.02%** under the same conditions.

The document is strongest in Sections 2 (Topology) and 6 (Failure Modes). It is weakest in Section 4 (Deduplication Semantics), where the guarantees are stated informally and, in at least one place, appear to contradict the retry policy described in Section 7. ==Section 4 must be rewritten before board review.== The remaining issues are editorial or minor.

I spent approximately eleven hours on this review, including a two-hour walkthrough with the author on 15 March, where several of the questions below were raised verbally and are recorded here for the record.

---

## 2. Findings

### 2.1 Blocking

1. **Deduplication window is under-specified.** Section 4.2 states that duplicates are suppressed "within the active window" but never defines the window's boundaries, whether it is wall-clock or event-time, or what happens to events straddling a rotation. Given a stated rotation interval of 90 seconds and an observed p99 device clock skew of 4.2 seconds, straddling events are not a rare edge case — I estimate **190,000 events per day** at current volumes.
2. **Contradiction between Sections 4 and 7.** Section 4.4 claims at-most-once delivery downstream of the dedup layer. Section 7.1 describes a retry policy that re-emits from the pre-dedup buffer after a sink timeout, which yields at-least-once. Both cannot hold. My reading is that the intended guarantee is *effectively-once within the dedup window*, but the document should say so explicitly and name the assumptions.
3. **No backpressure story for the fan-out.** Section 3 assumes partition consumers keep pace. There is no described behavior when one of the twelve partitions lags. The current pipeline handles this badly, and the draft does not claim improvement.

### 2.2 Non-blocking but important

4. **Capacity numbers are stale.** Table 3.1 cites a peak of 41,000 events/sec from the Q3 capacity model. The Q1 refresh puts peak at 58,400 events/sec, with a projected 72,000 by Q4. Sizing conclusions in Section 8 should be recomputed.
5. **The Bloom filter false-positive budget is asserted, not derived.** Section 4.6 states a target FPR of 0.001 without showing the bit-array sizing or hash count that yields it. Please show the arithmetic; readers will need it when tuning.
6. **Observability is thin.** Section 9 lists four metrics. I would expect at minimum: per-partition lag, dedup hit ratio, filter saturation, rotation latency, and sink error rate by class.

### 2.3 Minor

7. Figure 2 uses "collector" and "ingress agent" for what appears to be the same component.
8. The glossary omits *watermark*, *rotation epoch*, and *sink class*, all of which appear repeatedly.
9. Section 10 references an internal runbook that has been deprecated since January.

---

## 3. Illustrative Concern (Section 4.2)

The straddling-event problem is easier to see in code than in prose. Roughly, the draft implies the following:

```python
def accept(event, filters, now):
    epoch = now // ROTATION_SECONDS
    active = filters[epoch % 2]
    key = (event.device_id, event.sequence)
    if key in active:
        return False          # suppressed as duplicate
    active.add(key)
    return True
```

With a two-filter rotation and no overlap read, an event arriving at `epoch` boundary + 0.1s will not be checked against the prior epoch's filter, so a duplicate delivered 91 seconds after its original will be accepted. *This is precisely the interval in which the retry policy in Section 7.1 operates,* which is why findings 1 and 2 are coupled rather than independent. A grace read against the previous filter would resolve it at the cost of a modest increase in false positives.

> During the 15 March walkthrough, the author noted that an overlap read had been prototyped but was removed because it complicated the metrics. That rationale should appear in the document as a rejected alternative, with the metric complication described, rather than being absent entirely.

---

## 4. Open Questions

- Is the 90-second rotation interval derived from anything, or was it chosen for convenience? What breaks at 30 seconds or 300?
- What is the intended behavior when a device replays its entire sequence range after a firmware reset? Does the sequence number reset to zero, and if so, does the dedup key collide with historical events?
- Who owns the partition assignment map, and is rebalancing manual or automatic?
- Has anyone modeled the cost delta? Section 8 gives infrastructure sizing but no dollar figure, and the fan-out roughly triples consumer instance count.
- Does the design need to survive a full regional outage, or only a zone outage? Section 6 is ambiguous, and the answer changes the replication requirements substantially.

---

## 5. Recommended Changes

| # | Section | Change | Priority |
|---|---------|--------|----------|
| R1 | 4.2 | Define the dedup window formally: event-time vs. wall-clock, boundaries, straddle handling | Blocking |
| R2 | 4.4 / 7.1 | Reconcile the delivery guarantee; state it once, canonically | Blocking |
| R3 | 3.4 | Add a backpressure subsection covering partition lag and shed policy | Blocking |
| R4 | 3.1, 8 | Refresh capacity figures against the Q1 model and recompute sizing | High |
| R5 | 4.6 | Show the FPR derivation with bit-array size and hash count | High |
| R6 | 9 | Expand the metrics list; add alert thresholds for at least three | Medium |
| R7 | 4.7 (new) | Add a "Rejected Alternatives" subsection covering the overlap read | Medium |
| R8 | Fig. 2, Glossary | Normalize component naming; add three missing terms | Low |
| R9 | 10 | Replace the deprecated runbook reference | Low |

---

## 6. Next Steps

I propose the author circulates a rev. 15 addressing **R1–R3** by **26 March**, which leaves a week for a focused re-review of those sections only before the board date. R4–R9 can land in rev. 16 without blocking approval, provided the tracking issues are filed and linked from the document header.

I am happy to co-author the backpressure subsection if that helps the timeline — I wrote the equivalent section for the Halberd pipeline last year and much of the reasoning transfers.
