# Review Summary — *Orchid Ledger: Settlement Service v3 Migration Plan* (Draft 4, rev. 2024-11-08)

**Reviewer:** Priya Ramaswamy, Staff Engineer, Platform Reliability
**Document owner:** Tobias Lindqvist, Payments Infrastructure
**Review window:** 2024-11-11 → 2024-11-15
**Verdict:** *Approve with changes* — the architecture is sound, but the cutover plan and failure-mode analysis are not yet operationally credible.

---

## Scope of Review

I reviewed all nine sections (42 pages) plus Appendix C (schema diffs) and Appendix E (load-test results). I did not review Appendix D (vendor contract terms), which is outside my remit and appears to be pending Legal sign-off from Marguerite Osei.

## Summary of Findings

The document proposes replacing the current single-writer settlement engine with a partitioned, event-sourced service backed by a durable log. The rationale in §2 is persuasive: at the projected 2025 volume of 14,800 settlement events per second, the existing engine's advisory-lock contention becomes the dominant latency term, and the measured p99 of 840 ms already exceeds the 500 ms internal target.

**Strengths.**

1. **§3 (Partitioning strategy)** is the strongest section. Keying by `merchant_account_id` rather than `transaction_id` correctly preserves per-merchant ordering, which is the only ordering guarantee downstream reconciliation actually depends on. The rebalancing protocol described in §3.4 is straightforward and testable.
2. **Appendix E** is unusually honest. Reporting the 6.2% error rate observed during the third load run — instead of silently rerunning it — makes the whole document more trustworthy.
3. **§7 (Observability)** specifies emitted metrics with cardinality budgets, which is a level of rigor most design docs in this org skip.

**Material concerns.**

1. **The dual-write window is underspecified (§5.2).** The plan states that v2 and v3 will both write settlement records for "a period of stabilization" but never bounds that period, names an owner, or defines the divergence threshold that would trigger rollback. In my experience these windows expand indefinitely unless a date is committed in writing.
2. **No reconciliation story for in-flight state (§5.4).** At cutover there will be settlements that have been accepted by v2 but not yet finalized. The document assumes this set is empty because the drain step precedes cutover, but the drain is described as "best effort." Best-effort drains leave residue.
3. **Idempotency key collision risk (§4.3).** The proposed key is `sha256(merchant_account_id || amount_minor || rounded_timestamp)` with a 60-second rounding bucket. Two legitimate identical-amount charges from the same merchant within one bucket would be silently deduplicated. This is a correctness bug, not a tuning parameter. The key must include a client-supplied nonce.
4. **Backpressure behavior is unstated (§6).** When the log broker is unavailable, does the API return 503, buffer to local disk, or block? Each choice has different implications for the upstream gateway's retry storm behavior.
5. **The 11-week timeline (§8) does not include a bake period.** Weeks 9–11 are cutover, decommission, and documentation. There is no interval where v3 carries full production traffic while v2 remains recoverable.

> The plan's central assumption — that partitioning removes the ordering constraint rather than relocating it — deserves an explicit paragraph. Ordering does not disappear; it moves to the rebalance boundary, and that boundary is where I expect the first production incident to originate.

Suggested illustration for §4.3, showing the key construction I'd propose instead:

```python
def idempotency_key(req):
    # Client nonce is REQUIRED; no timestamp bucketing.
    if not req.client_nonce:
        raise BadRequest("client_nonce is required")
    material = "|".join([
        req.merchant_account_id,
        str(req.amount_minor),
        req.currency,
        req.client_nonce,
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
```

## Open Questions

1. What is the retention period on the durable log, and does it exceed the longest legally mandated dispute window (I believe 180 days)?
2. Who owns the rebalance protocol at 03:00 on a Sunday? §3.4 describes the mechanism but names no on-call rotation.
3. Has the 6.2% error rate from load run 3 been root-caused, or is it still attributed to "test harness instability"?
4. Does the reconciliation team (Devansh Kapoor's group) have a signed-off schema contract, or is Appendix C aspirational?
5. What happens to the 2,100 merchants currently on the legacy fee schedule — are they in scope for migration or explicitly deferred?

## Recommended Changes

- [x] Add a version/date header and a changelog table to page 1
- [x] Correct the throughput figure in §2.1 (states 14,800/s; Appendix E measures 12,400/s)
- [x] Fix the broken cross-reference from §6.2 to "§9.3," which does not exist
- [ ] Replace the timestamp-bucketed idempotency key with a client-nonce construction (§4.3) — **blocking**
- [ ] Bound the dual-write window to a specific number of days with a named owner (§5.2) — **blocking**
- [ ] Add a backpressure subsection to §6 specifying broker-unavailable behavior — **blocking**
- [ ] Insert a two-week bake period into the §8 timeline before decommission
- [ ] Add a rollback runbook as Appendix F, including the maximum tolerable data divergence
- [ ] Document the in-flight settlement reconciliation procedure (§5.4)
- [ ] Clarify legacy fee-schedule merchant scope in §1.3

## Next Steps

I suggest a 45-minute working session with Tobias, Devansh, and someone from Gateway to close the three blocking items. If those are resolved, I expect to sign off on Draft 5 without a further full review. Non-blocking items can be tracked as follow-ups against the migration epic rather than gating approval.
