# Review Summary: *Nimbus Ledger — Technical Design Document v0.9*

**Reviewer:** Dr. Ilse Vantroost, Platform Architecture Guild
**Review window:** 11–18 March, cycle 4
**Document owner:** Marek Olubanjo (Payments Infrastructure)
**Verdict:** ==Approve with mandatory revisions before implementation kickoff.==

---

## 1. Scope of Review

I read all 62 pages of the design document, the appendix on shard rebalancing, and the three sequence diagrams attached as supplementary material. I did **not** review the accompanying cost model spreadsheet (`nimbus-tco-v3.ods`), which was locked at the time of review, nor the vendor contract summary referenced in §9.4.

The document proposes replacing the existing single-region settlement store with a horizontally partitioned ledger service supporting *at-least-once* event ingestion, deterministic replay, and sub-200 ms p99 read latency across four regions.

Overall the design is **coherent and unusually well-argued**, particularly the section on idempotency keys. My concerns cluster around three areas: failure semantics during partial region loss, the migration cutover plan, and observability gaps that would make the first production incident very difficult to diagnose.

---

## 2. Summary of Findings

### 2.1 Strengths

- The partition key selection (`tenant_id` + `settlement_day`) is well justified with real traffic data from Q3.
- The replay protocol is described precisely enough that I could reconstruct it independently and reach the same conclusions.
- Backward compatibility with the legacy `v1/settlements` API is preserved through a translation shim, which reduces client migration risk substantially.

### 2.2 Concerns by Severity

| ID | Severity | Area | Summary |
|----|----------|------|---------|
| F-01 | Blocker | Consistency | Write path allows split-brain during regional isolation |
| F-02 | Blocker | Migration | No documented rollback after dual-write phase begins |
| F-03 | Major | Observability | No per-shard lag metric; only aggregate |
| F-04 | Major | Capacity | Shard count fixed at 64; resplit path undefined |
| F-05 | Minor | API | Error taxonomy inconsistent between §5.2 and §7.1 |
| F-06 | Minor | Docs | Three diagrams lack version stamps |

### 2.3 Detail on Blockers

**F-01 — Split-brain on regional isolation.** §4.6 states that when a region loses quorum contact, it continues to accept writes into a local buffer for up to 90 seconds before shedding load. Combined with the client-side retry policy in §6.3 (which fails over to the nearest healthy region after 12 seconds), this creates a 78-second window in which the *same logical settlement* can be written in two regions with different sequence numbers. The idempotency key protects against duplicate *application*, but not against divergent ordering, and the replay protocol in §8 assumes a total order per partition.

I constructed the following scenario and could not find text in the document that prevents it:

```python
# Reconstruction of the divergence window described in F-01.
# Wall-clock times are relative to onset of the partition at t=0.

TIMELINE = [
    (0.0,   "region-eu", "loses quorum contact; enters local buffer mode"),
    (3.4,   "client-88", "writes SETTLE-4471 -> region-eu, buffered, seq=local:9"),
    (12.1,  "client-88", "retry timeout; fails over to region-us"),
    (12.3,  "client-88", "writes SETTLE-4471 -> region-us, committed, seq=global:8812"),
    (90.0,  "region-eu", "sheds load; begins buffer drain"),
    (91.7,  "region-eu", "drains SETTLE-4471 with local:9 -> conflicts"),
]

def divergent(events, key="SETTLE-4471"):
    writes = [e for e in events if key in e[2]]
    regions = {e[1] for e in writes}
    return len(regions) > 1 and len(writes) > 1

assert divergent(TIMELINE), "expected a single-region write"
print("Divergence window:", 90.0 - 12.1, "seconds")  # -> 77.9 seconds
```

The document needs either (a) a shortened buffer window that closes strictly *before* the client failover threshold, with a proof of the inequality under clock skew, or (b) an explicit conflict-resolution rule at drain time with a defined loser-side compensation path.

**F-02 — Rollback after dual-write.** §10.2 describes a four-phase migration: shadow reads, dual writes, cutover, decommission. Phases 1 and 4 have documented rollback steps. Phase 2 does not. Once dual writes begin, the new store accumulates records the legacy store lacks (specifically the `reconciliation_hint` field introduced in §3.8), so reverting to legacy-only leaves those records unreachable. This is a *one-way door* presented as a reversible step, which I consider the highest-risk item in the document.

---

## 3. Questions for the Author

1. What is the assumed maximum clock skew between regions, and where is it enforced? §4.6 depends on time comparisons but never states a bound.
2. Is the 64-shard count derived from projected 2027 volume or from current volume with headroom? The two readings imply very different resplit urgency.
3. Does the translation shim in §11 preserve the legacy API's *ordering guarantee* for batch submissions, or only per-item semantics?
4. What happens to in-flight buffered writes if a region is intentionally drained for maintenance rather than failing? §4.6 covers only unplanned loss.
5. Who owns the reconciliation runbook after decommission — the Payments team or the on-call platform rotation? §12 names neither.
6. Has the 200 ms p99 target been validated against the *cold cache* case, e.g. after a shard leader election?
7. Are `reconciliation_hint` values ever consumed by downstream systems, or is the field write-only for now?

---

## 4. Recommended Changes

### 4.1 Required Before Kickoff

- [x] Add a severity-ordered risk register (author added this on 14 March — thank you)
- [x] Version-stamp all diagrams
- [ ] Resolve F-01 with either a tightened buffer window or an explicit conflict rule
- [ ] Add a Phase 2 rollback procedure, including handling of orphaned `reconciliation_hint` records
- [ ] State the maximum tolerated clock skew and the mechanism that enforces it
- [ ] Reconcile the error taxonomy between §5.2 and §7.1

### 4.2 Strongly Recommended

- [ ] Define a shard resplit procedure, even if it is "manual, with 4 hours of planned downtime"
- [x] Add per-shard replication lag to the metrics table
- [ ] Add a worked example of a replay after a 6-hour outage
- [ ] Specify retention for the local write buffer

### 4.3 Optional Improvements

- [ ] Consolidate the three sequence diagrams into one with swimlanes
- [ ] Add a glossary; the terms *settlement*, *transaction*, and *entry* are used with distinct meanings that a new reader will conflate

---

## 5. Structural Suggestions

The document's organization would benefit from a reordering. My proposed structure:

- **Part I — Context**
    - Problem statement (currently §1, keep as-is)
    - Constraints
        - Regulatory
            - Data residency per jurisdiction
            - Retention floor of 7 years
            - Audit export format (currently buried in Appendix C)
        - Operational
            - Maximum planned downtime per quarter
            - On-call staffing assumptions
        - Technical
            - Existing client SDK versions in the field
            - Network topology between regions
- **Part II — Design**
    - Data model
    - Write path (merge current §4 and §6; they cross-reference eleven times)
    - Read path
    - Failure semantics *(new section — currently scattered across five places)*
- **Part III — Delivery**
    - Migration phases with rollback per phase
    - Observability and runbooks
    - Open questions

Pulling failure semantics into a single section is the change I would prioritize. At present, a reader must assemble the failure model from §4.6, §6.3, §8.2, Appendix B, and one footnote on page 41. That fragmentation is, I suspect, *why* F-01 survived the internal review.

---

## 6. Suggested Timeline

1. Author responds to questions in §3 — **by 22 March**
2. Revised draft circulated (v0.10) — **by 29 March**
3. Focused re-review of F-01 and F-02 only, 90 minutes, three reviewers — **1 April**
4. Architecture Guild sign-off vote — **4 April**
5. Implementation kickoff, contingent on sign-off — **7 April**

If F-01 requires a design change rather than a documentation change, steps 2–5 should each slip by roughly two weeks and I would want a second full review rather than a focused one.

---

## 7. Closing Note

To be clear about weighting: this is a **strong document** that identified and solved several problems I did not expect it to address, notably deterministic replay under partial shard loss. The blockers are real but narrow. I would expect both to be resolvable within two weeks without altering the core architecture — ==assuming the buffer-window question has a clean answer rather than a load-bearing one.==

Happy to pair on the failure-semantics section if that is useful.
