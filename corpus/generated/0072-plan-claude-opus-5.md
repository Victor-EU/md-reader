# Project Harbor Lantern — Delivery Plan

**Document owner:** Priya Raghunathan, Director of Platform Delivery
**Version:** 3.2 (revised 14 March)
**Distribution:** Steering Committee, Engineering Leads, Vendor Liaison Desk
**Classification:** Internal — Restricted

---

## 1. Purpose and Scope

Project Harbor Lantern replaces the aging Fernwick order-routing engine with a modular, event-driven service capable of handling 14,000 transactions per minute at peak, up from the current ceiling of 3,200. The programme covers the routing engine itself, the four downstream reconciliation adapters, and the migration of 212 legacy customer profiles held in the Marlowe datastore.

Out of scope: the customer-facing web portal redesign (tracked separately as Project Quillfeather), any change to the billing ledger, and the decommissioning of the Fernwick hardware, which Facilities will handle in Q4 under a separate capital line.

> The steering committee has agreed that schedule certainty outranks feature completeness. If a phase gate is at risk, we descope non-critical adapters before we move the date. This is a standing instruction and does not require re-approval.

---

## 2. Governance and Roles

| Role | Named Owner | Accountability |
|---|---|---|
| Executive Sponsor | Desmond Achterberg | Funding, escalation of last resort |
| Programme Director | Priya Raghunathan | Overall delivery, gate sign-off |
| Technical Lead | Ola Fenimore | Architecture, code quality, ADR approval |
| Data Migration Lead | Bettina Okoro-Sayles | Marlowe extraction and validation |
| QA Lead | Hendrik Vaals | Test strategy, defect triage |
| Vendor Liaison | Caro Middlemass | Contract with Threadneedle Systems |
| Change & Comms | Yusuf Anwarli | Training, runbook publication |

The Steering Committee meets fortnightly on Thursdays at 09:30. Delivery stand-ups run daily at 09:00 for fifteen minutes, chaired on rotation.

---

## 3. Phases

### Phase 0 — Discovery and Baseline (Weeks 1–4)

**Owner:** Ola Fenimore

Establish the factual baseline before design begins. The Fernwick engine has no current architecture documentation; the last diagram dates from 2019 and is known to be inaccurate in at least three places.

Activities:

- Instrument the existing engine for two full weeks to capture real traffic shapes
- Interview eleven operations staff on undocumented workarounds
- Produce the Baseline Capability Report (BCR-01)
- Draft the first six Architecture Decision Records

**Exit criteria:** BCR-01 signed by Fenimore and Vaals; traffic dataset of at least 9 million sampled events archived.

### Phase 1 — Core Engine Build (Weeks 5–16)

**Owner:** Ola Fenimore

Construction of the routing kernel, the rules evaluator, and the internal event bus. Threadneedle Systems supplies the durable queue component under contract TN-4471.

The team splits into three squads:

- **Squad Alder** — routing kernel and rule evaluation
  - Kernel core (Weeks 5–10)
    - Deterministic replay harness
      - Snapshot serialisation format
      - Replay divergence detector
      - Golden-file corpus of 480 recorded sessions
    - Rule compiler front-end
  - Kernel hardening (Weeks 11–16)
- **Squad Birchwood** — event bus and Threadneedle integration
  - Queue adapter and backpressure policy
  - Dead-letter handling and operator console hooks
- **Squad Cormorant** — observability and platform plumbing
  - Metric taxonomy and cardinality budget
  - Trace propagation across adapter boundaries

**Exit criteria:** Kernel sustains 16,000 TPM in the load lab for 90 minutes with p99 latency under 45ms; zero critical defects open.

### Phase 2 — Adapter Suite (Weeks 14–24)

**Owner:** Hendrik Vaals (delivery), Ola Fenimore (technical)

Four reconciliation adapters, built in priority order. Phase 2 overlaps Phase 1 by three weeks deliberately, since adapter work depends only on the published kernel contract, which freezes at Week 13.

Priority order, confirmed by the Steering Committee:

1. **Adapter Saltmarsh** — settlement reconciliation, highest transaction volume, non-negotiable
2. **Adapter Grimsby** — regulatory reporting feed, fixed external deadline
3. **Adapter Pelham** — internal treasury sweep, moderate value
4. **Adapter Wren** — analytics export, first candidate for descope

**Exit criteria:** Saltmarsh and Grimsby pass full contract-test suites; Pelham at minimum in beta.

### Phase 3 — Data Migration (Weeks 20–30)

**Owner:** Bettina Okoro-Sayles

The Marlowe datastore holds 212 customer profiles, of which 38 use a deprecated nested-entitlement structure that has no direct equivalent in the new schema. These require a hand-authored mapping, estimated at four hours each.

Migration proceeds in three waves: 40 low-risk profiles, then 100, then the remaining 72 including all deprecated structures.

Validation approach:

```python
def validate_wave(wave_id, source_records, target_records):
    """Compare migrated profiles against source. Returns a report dict."""
    discrepancies = []
    for key in source_records:
        src = source_records[key]
        tgt = target_records.get(key)
        if tgt is None:
            discrepancies.append((key, "MISSING_IN_TARGET", None))
            continue
        if src.entitlement_hash != tgt.entitlement_hash:
            discrepancies.append((key, "HASH_MISMATCH", tgt.entitlement_hash))
        if abs(src.credit_ceiling - tgt.credit_ceiling) > 0.005:
            discrepancies.append((key, "CEILING_DRIFT", tgt.credit_ceiling))

    return {
        "wave": wave_id,
        "checked": len(source_records),
        "failed": len(discrepancies),
        "pass_rate": round(1 - len(discrepancies) / max(len(source_records), 1), 4),
        "detail": discrepancies,
    }
```

A wave is accepted at a pass rate of 1.0000. There is no tolerance band; any discrepancy blocks promotion of that wave.

**Exit criteria:** All three waves accepted; rollback snapshot verified restorable within 20 minutes.

### Phase 4 — Cutover and Stabilisation (Weeks 31–36)

**Owner:** Priya Raghunathan

Dual-run for eleven days with traffic shadowed to the new engine, then a staged traffic shift: 5%, 25%, 60%, 100%, with a minimum 36-hour soak at each step. Yusuf Anwarli publishes operator runbooks no later than Week 30.

**Exit criteria:** Seven consecutive days at 100% traffic with fewer than three P2 incidents and zero P1 incidents.

---

## 4. Milestones

| ID | Milestone | Target Week | Owner |
|---|---|---|---|
| M1 | Baseline Capability Report accepted | 4 | Fenimore |
| M2 | Kernel contract frozen | 13 | Fenimore |
| M3 | Load target of 16,000 TPM demonstrated | 16 | Fenimore |
| M4 | Saltmarsh adapter certified | 21 | Vaals |
| M5 | Grimsby adapter certified | 24 | Vaals |
| M6 | Migration Wave 3 accepted | 30 | Okoro-Sayles |
| M7 | Dual-run complete, no blocking findings | 33 | Raghunathan |
| M8 | 100% traffic sustained seven days | 36 | Raghunathan |

---

## 5. Risks

**R-01 — Threadneedle queue component underperforms (High / Medium)**
Contract TN-4471 guarantees 18,000 messages per minute, but the figure is unverified in our topology. *Mitigation:* independent benchmark by Week 9; fallback implementation of a file-backed queue scoped at 14 engineer-days. Owner: Caro Middlemass.

**R-02 — Deprecated entitlement mappings exceed estimate (High / High)**
The four-hour-per-profile figure comes from a sample of three. If the true average is eight hours, Phase 3 slips by roughly two weeks. *Mitigation:* re-estimate after the first twelve mappings; pre-approved budget for two contract analysts. Owner: Bettina Okoro-Sayles.

**R-03 — Kernel contract churn after Week 13 freeze (Medium / Medium)**
Adapter squads cannot absorb late interface changes. *Mitigation:* any post-freeze change requires joint sign-off from Fenimore and Vaals and a written impact note. Owner: Ola Fenimore.

**R-04 — Grimsby regulatory deadline immovable (High / Low)**
The external filing date sits at Week 26 with no extension mechanism. *Mitigation:* Grimsby elevated to second build priority; contingency of a manual filing process documented by Week 22. Owner: Hendrik Vaals.

**R-05 — Key-person concentration on the replay harness (Medium / Medium)**
Only two engineers understand the divergence detector. *Mitigation:* mandatory pairing rotation from Week 8; design note published by Week 12. Owner: Ola Fenimore.

**R-06 — Operations staff unavailable during cutover (Medium / Medium)**
Phase 4 overlaps the annual audit window. *Mitigation:* negotiate a two-week audit deferral with Achterberg by Week 26; otherwise shift cutover to Week 34. Owner: Yusuf Anwarli.

---

## 6. Reporting

A one-page status note circulates every Monday by 12:00, covering milestone position, open risks above the medium threshold, and burn against the 4,180 engineer-day budget. Exceptions escalate to Desmond Achterberg within one working day of identification.
