# Review Summary: "Adaptive Retention Policies for Multi-Tenant Event Ledgers" (Draft v0.4)

**Document ID:** ARCH-2291
**Author:** Priya Vantalak, Platform Data Group
**Reviewer:** Desmond Okereke, Reliability Architecture
**Review date:** 14 March
**Review type:** Pre-implementation design review (blocking)
**Recommendation:** Approve with required changes (see "Blocking Items")

---

## 1. Purpose and Scope of This Review

The draft proposes replacing the fixed 90-day retention window on the Halberd event ledger with a per-tenant adaptive policy engine. The stated goals are to cut cold-storage spend by roughly 38% and to give enterprise tenants configurable retention between 7 and 2,555 days.

I reviewed sections 1 through 9 plus Appendix C. I did **not** review Appendix D (billing reconciliation), which is owned by the Revenue Systems team and is still marked as a stub. My review focused on correctness of the state model, operational safety, migration risk, and whether the document gives an implementer enough to build from without a second design round.

Overall the document is in good shape structurally. The problem statement is crisp, the cost model is defensible, and the author has clearly thought hard about the tricky part — what happens when a tenant *shortens* their retention window and data must be destroyed rather than merely aged out. My concerns are concentrated in three areas: the deletion state machine has an unreachable-but-documented state, the migration plan understates blast radius, and the document is silent on legal hold interaction, which I consider a hard gap.

---

## 2. Summary of Findings

### 2.1 Strengths

- The cost analysis in §3 is unusually rigorous for a design doc. The author separates storage cost from index maintenance cost, which most proposals in this area conflate.
- The decision to keep retention evaluation out of the write path is correct and well argued. Deferring to a sweeper avoids adding a policy lookup to a 40k-writes-per-second hot path.
- §7's discussion of idempotent deletion is thorough. The tombstone-with-generation-counter approach handles the replay case cleanly.
- The rejected-alternatives section (§8) is genuinely useful. Explaining *why* per-partition TTL was rejected will save future readers a week.

### 2.2 Concerns by Severity

| Severity | Count | Areas |
|---|---|---|
| Blocking | 3 | State machine, legal hold, migration rollback |
| Major | 4 | Sweeper throughput, clock skew, audit trail, quota interaction |
| Minor | 6 | Terminology, diagrams, table formatting, naming |

---

## 3. Blocking Items

### 3.1 The `PENDING_PURGE` state appears unreachable

Section 5.2 defines five states for a ledger segment: `ACTIVE`, `SEALED`, `EXPIRING`, `PENDING_PURGE`, and `PURGED`. The transition table lists an edge from `EXPIRING` to `PENDING_PURGE` gated on `sweeper_claim_acquired == true`, but §5.4 states that the sweeper acquires its claim *before* marking a segment as `EXPIRING`. If that ordering is correct, no segment can ever be in `EXPIRING` without a claim, and `PENDING_PURGE` is either unreachable or redundant with `EXPIRING`.

Either the state is vestigial and should be removed, or §5.4's ordering is wrong. I suspect the latter — a two-phase claim would be a reasonable design — but the document must pick one.

Here is the model as I read it, which the author should confirm or correct:

```python
# Reviewer's reconstruction of the segment lifecycle as written in §5.2-5.4.
# This is my reading, not the author's code — please verify.

from enum import Enum, auto

class SegmentState(Enum):
    ACTIVE = auto()
    SEALED = auto()
    EXPIRING = auto()
    PENDING_PURGE = auto()   # <-- appears unreachable
    PURGED = auto()

ALLOWED = {
    SegmentState.ACTIVE:        {SegmentState.SEALED},
    SegmentState.SEALED:        {SegmentState.EXPIRING},
    SegmentState.EXPIRING:      {SegmentState.PENDING_PURGE,
                                 SegmentState.SEALED},   # policy extended
    SegmentState.PENDING_PURGE: {SegmentState.PURGED},
    SegmentState.PURGED:        set(),
}

def advance(segment, target, claim_held):
    if target not in ALLOWED[segment.state]:
        raise IllegalTransition(segment.state, target)
    if target is SegmentState.PENDING_PURGE and not claim_held:
        raise ClaimRequired(segment.id)
    # Per section 5.4, the sweeper already holds a claim before it can
    # set EXPIRING at all, so the guard above never fires in practice.
    segment.state = target
    segment.generation += 1
    return segment
```

If the guard can never fail, it is dead code that will rot. If it *can* fail, §5.4 needs rewriting.

### 3.2 Legal hold is not addressed anywhere

The document never uses the phrase "legal hold," "litigation hold," or "preservation order." For a system whose entire purpose is destroying customer data on a schedule, this is a hard gap. Compliance placed 214 tenant-scoped holds last fiscal year under the existing manual process; those holds currently work because retention is fixed and deletion is a quarterly human-run job.

The adaptive engine automates deletion. Without an explicit hold check that takes precedence over tenant policy, we will destroy data under preservation order within weeks of launch.

> A retention system that cannot refuse to delete is not a retention system. It is a shredder with a calendar.

At minimum the design needs: a hold registry consulted by the sweeper, a fail-closed default when the registry is unreachable, and an alert when a hold blocks a purge for more than 30 days.

### 3.3 Migration rollback is asserted, not designed

Section 9.3 states that the migration is "fully reversible up to the point of first purge." I do not believe this. The migration rewrites the segment metadata table in place, dropping the `legacy_expiry_ts` column in step 4 of 7. Once that column is gone, reconstructing the old fixed-window behaviour requires recomputing expiry from segment seal time, which is only retained for segments sealed after the ledger v3 upgrade. Roughly 11% of live segments predate that upgrade.

Recommend: retain `legacy_expiry_ts` as a nullable shadow column for two full release cycles, and add an explicit rollback runbook to Appendix B rather than a one-sentence assertion.

---

## 4. Major Concerns

- **Sweeper throughput is unmodeled.** §6 gives a sweeper interval of 15 minutes but no estimate of segments evaluated per pass. At current growth, I estimate 1.9M candidate segments by Q4. Please add a throughput budget.
- **Clock skew.** Expiry comparisons use node-local time (§6.2). With a stated tolerance of ±2s, a segment could purge up to 2s early. That is fine for 90-day windows and not fine for the 7-day minimum. Recommend deriving expiry from a single authority.
- **Audit trail granularity.** §7.4 logs purge events at segment granularity. Compliance has asked for record-count attestation. Segment counts are not record counts.
- **Quota interaction.** If a tenant's retention extension pushes them over their storage quota, does the extension fail or does the quota soften? Undefined.

---

## 5. Open Questions

1. When a tenant shortens retention from 365 to 30 days, is the resulting purge immediate or does it respect a grace period? §4.1 implies immediate; §7.2 mentions a "cooling window" that is never defined.
2. Who owns the policy schema — Platform Data or the Tenant Config service? The document uses both names for what looks like one thing.
3. Is the 2,555-day maximum (seven years) a product decision or a storage-tier limitation? If the former, where is it recorded?
4. What is the expected p99 latency of a policy lookup during the sweeper pass, and is that lookup cached?
5. Does the design intend to support per-event-type retention within a tenant, or only per-tenant? §2 hints at the former; the schema in Appendix C supports only the latter.
6. What happens to a segment that is `EXPIRING` when its tenant is deleted entirely?

---

## 6. Recommended Changes

- [x] Add a severity-tagged summary table at the top of the document
- [x] Correct the segment count in §3.2 (states 840k, dashboard shows 1.12M)
- [ ] Resolve the `PENDING_PURGE` reachability question in §5.2–5.4
- [ ] Add a legal hold section with the following structure:
    - [ ] Hold registry interface and ownership
        - [ ] Read path used by the sweeper
            - [ ] Timeout behaviour and fail-closed default
            - [ ] Cache invalidation on hold placement
            - [ ] Metric emitted when a hold blocks a purge
        - [ ] Write path used by Compliance tooling
    - [ ] Precedence rules when hold and tenant policy conflict
    - [ ] Expiry and release of holds
- [ ] Replace the rollback assertion in §9.3 with a real runbook
- [ ] Add sweeper throughput budget to §6
- [ ] Define the "cooling window" or remove the term
- [ ] Add record-count attestation to the audit design
- [ ] Normalize terminology: pick either "policy engine" or "retention controller"
- [ ] Fix Figure 4 — the arrow from the sweeper to the metadata store is reversed
- [ ] Fill in or explicitly defer Appendix D with an owner and date

---

## 7. Suggested Next Steps

I recommend a 45-minute working session with the author, one Compliance representative, and someone from Revenue Systems to close the legal hold gap and the Appendix D dependency. The state machine question can likely be resolved asynchronously.

I am happy to re-review v0.5 within two business days of receipt. If the blocking items are addressed, I do not expect to need a third round.
