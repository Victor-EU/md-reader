# Review Summary: *Northgate Telemetry Pipeline — Design Specification v0.9*

**Reviewer:** Dr. Imani Vosburgh, Platform Reliability Group
**Date of review:** 14 March 2031
**Document owner:** Kestrel Adeyemi-Lund
**Pages reviewed:** 1–58 (Appendix D skipped, see Question 6)
**Overall verdict:** ==Approve with revisions== — the architecture is sound, but the failure-domain analysis and the cost model both need substantial rework before this goes to the Architecture Board on 2 April.

---

## 1. Summary of the Document

The specification proposes replacing the existing Harrowfield ingest cluster with a three-tier pipeline: a stateless edge collector fleet, a durable buffering layer backed by segmented logs, and a fan-out projection service that materialises views for the dashboards used by roughly **3,400 internal users**. The authors claim a steady-state throughput target of 180,000 events per second with a p99 end-to-end latency of 900 ms, and a projected annual infrastructure spend of $412,000.

The writing is clear and the diagrams in Section 4 are genuinely excellent — *the sequence diagram on page 22 explains the backpressure handshake better than three pages of prose could have.* My concerns are concentrated in Sections 6 (Failure Modes), 8 (Capacity Planning), and the migration timeline in Section 11.

---

## 2. Key Findings

### 2.1 Strengths

- The choice to make the collector fleet **fully stateless** is correct and well-argued. It removes the operational burden that made the Harrowfield rollback in 2029 so painful.
- Schema evolution is handled properly: forward and backward compatibility rules are explicit, and the registry ownership model assigns a named team to each subject prefix.
- The document does not overclaim. Section 3.4 openly admits that the projection service will not support ad-hoc joins, and directs those workloads to the analytics warehouse instead.

### 2.2 Concerns

1. **The failure-domain analysis is incomplete.** Section 6 enumerates node-level and zone-level failures but never addresses correlated failures across the buffering layer.
   - The spec assumes three availability zones with replication factor 3.
     - It does not state whether the replication is rack-aware *within* a zone.
       - If it is not, a single top-of-rack switch failure in Zone B could take down two of three replicas for a subset of partitions.
       - Our incident record from November 2030 (INC-4417) showed exactly this pattern on a different cluster.
     - There is no discussion of what happens when a zone is *slow* rather than *down* — the gray-failure case.
2. **The capacity model uses average event size, not a distribution.** Section 8.2 assumes 1.4 KB per event. Our sampling of the current Harrowfield stream shows a long right tail: median 0.9 KB, p95 6.2 KB, p99.9 41 KB. A model built on the mean will underprovision buffer memory by an estimated 35–50% during batch-import windows.
3. **The cost figure omits cross-zone egress.** At the stated replication factor and throughput, I calculate roughly $88,000/year in inter-zone transfer alone, which is not in the $412,000 total.
4. **Migration ordering is risky.** Section 11 proposes cutting over the projection service *before* the buffering layer has run in production for a full quarter. This inverts the usual risk gradient.

---

## 3. Illustrative Correction

The retry logic sketched in Section 7.3 will amplify load during a partial outage because the backoff is linear and unjittered. Suggested replacement:

```python
import random

def backoff_delay(attempt, base=0.25, cap=30.0):
    """Exponential backoff with full jitter, in seconds."""
    ceiling = min(cap, base * (2 ** attempt))
    return random.uniform(0, ceiling)

def should_retry(attempt, error):
    if error.kind in {"schema_invalid", "auth_denied"}:
        return False          # never retry non-transient errors
    return attempt < 6
```

The important change is the **full-jitter** term. Without it, a fleet of 240 collectors that all fail at the same instant will retry in a synchronised wave, which is precisely the behaviour that turned INC-4417 from a two-minute blip into a forty-minute outage.

---

## 4. Questions for the Authors

1. Is the buffering layer rack-aware within each availability zone? If not, what is the plan?
2. What is the intended behaviour when the schema registry itself is unreachable — fail open, fail closed, or serve from a local cache with a TTL?
3. Section 5.1 mentions a "reconciliation sweep" but never defines its cadence. Hourly? Daily?
4. Has anyone modelled the projection service under a *replay* workload, where six hours of history is re-fed at 8× real time?
5. Who owns the on-call rotation for the collector fleet after cutover — the Platform group or the originating service teams?
6. Appendix D was referenced four times but appears to be missing from the circulated PDF. Could it be resent?
7. What is the retention policy for the dead-letter topic, and who audits it?

---

## 5. Recommended Changes

- [x] Add explicit p99.9 event-size figures to Section 8.2 and rebuild the memory model on the distribution rather than the mean.
- [x] Include cross-zone egress in the cost table in Section 9.
- [ ] Extend Section 6 with a correlated-failure subsection covering rack-level and gray-failure scenarios.
- [ ] Replace the linear backoff in Section 7.3 with the jittered exponential form above.
- [ ] Reverse the migration ordering in Section 11 so the buffering layer soaks for a minimum of ninety days before projection cutover.
- [x] Define the reconciliation sweep cadence in Section 5.1.
- [ ] Add a rollback procedure with a stated maximum rollback window (I suggest **four hours**).
- [ ] Circulate Appendix D.
- [x] Fix the figure numbering — two separate diagrams are both labelled Figure 12.

---

## 6. Severity Breakdown

| Severity | Count | Blocking for Board review? |
|---|---|---|
| Critical | 2 | Yes |
| Major | 3 | Yes |
| Minor | 7 | No |
| Editorial | 11 | No |

The two critical items are the correlated-failure gap and the migration ordering. *Everything else can be handled in a follow-up revision without delaying the schedule.*

---

## 7. Suggested Next Step

I would like a **ninety-minute working session** with Kestrel and whoever owns the capacity model, ideally before 25 March, to walk through the buffer-sizing arithmetic together. I am happy to bring the Harrowfield sampling data. If the numbers hold up under joint scrutiny, I will withdraw finding 2.2.2 without argument.
