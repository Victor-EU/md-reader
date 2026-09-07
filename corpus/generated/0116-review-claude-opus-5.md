# Review Summary — *Kestrel: Unified Telemetry Ingestion Pipeline*, Design Draft v0.9

**Document under review:** `DES-2291 — Kestrel Unified Telemetry Ingestion Pipeline (v0.9, 41 pages)`
**Authors:** Marisol Trent (lead), Devan Okoro, Priya Raghunathan
**Reviewer:** Nils Barrowman, Platform Reliability
**Review window:** 14–21 March, 8.5 hours logged
**Disposition:** ==Approve with required changes== — not ready for architecture board sign-off in its current form.

---

## 1. Overall Assessment

The draft makes a persuasive case that our three parallel telemetry paths (the legacy `HoloStream` agent, the Vector-based sidecar fleet, and the ad-hoc Lambda shippers used by Payments) impose a genuine and measurable cost: the authors estimate **$418,000/year** in duplicated egress and storage, plus roughly 240 engineer-hours per quarter spent reconciling metric discrepancies. Those numbers are credible and align with what Finance reported in the Q4 infrastructure retrospective (their figure was $392,000, close enough that the gap is likely a schema-attribution difference rather than an error).

Where the document is strong, it is *very* strong. Section 4 (Ingest Contract) is the clearest specification of a wire format I have read from this team. The decision to make the schema registry authoritative at write time rather than read time is correct, and the authors defend it well against the obvious objection that it slows the hot path. Section 7's failure-mode taxonomy is thorough and honest about the sharp edges.

Where it is weak, the weakness is concentrated in three places: **the migration story, the multi-tenant isolation model, and the cost projections beyond year one.** These are not cosmetic gaps. Each one, left unresolved, could produce an outcome where Kestrel ships successfully as a technology and fails as a program.

> The pattern I want to avoid is the one we lived through with the storage consolidation effort in 2022: an elegant new system that ran alongside the old system for nineteen months because nobody owned the decommissioning work, and the promised savings never materialized because we paid for both. The design document is the right place to name the owner and the date. This one does not.

---

## 2. Findings

### 2.1 Major findings (must be resolved before board review)

- **F-1: The migration plan has no decommissioning owner or trigger condition.**
  Section 9 describes a "dual-write period" but never says who decides it has ended.
  - The document says dual-write will last "approximately two quarters." That is a hope, not a plan.
  - There is no defined **cutover criterion** — no metric threshold, no parity test, no acceptance gate.
    - Suggested criterion: sustained 99.95% record-level parity across all four tenant classes for 14 consecutive days, measured by the reconciler described in §6.3.
      - Parity should be computed on a *sampled* basis (1-in-2000) to keep the reconciler's own cost bounded; the document currently implies full-stream comparison, which would roughly double ingest cost during the overlap.
      - The sampler must be deterministic on `trace_id` so the same records are compared on both sides.
- **F-2: Tenant isolation relies on a shared partition pool with no quota enforcement.**
  §5.2 assigns partitions by hash of `tenant_id`, which means one noisy tenant can starve neighbors on the same partition. The draft acknowledges this in a footnote and defers it to "a future rate-limiting layer." That is unacceptable for a system that will carry Payments traffic.
  - At minimum the design needs per-tenant admission control at the edge, with a token bucket sized from the tenant's contracted throughput.
  - The document should state what happens when a tenant exceeds quota: shed, queue, or degrade to sampled ingestion. *These are very different products.*
- **F-3: Cost model stops at month 12 and omits retention growth.**
  Table 8.1 projects steady-state cost as flat after the migration completes. Telemetry volume at Northwind has grown **31–44% year over year** for four consecutive years. A flat projection is not defensible.
  - The three-year model should include at least a low/base/high volume band.
  - Retention tiering (hot 7d / warm 90d / cold 400d) is mentioned in §3 but never priced.

### 2.2 Moderate findings

- **F-4:** The schema evolution rules (§4.4) permit adding optional fields but are silent on *removing* deprecated ones. Without a removal path, the registry accumulates dead fields indefinitely. Propose a two-release deprecation window with automated consumer-usage checks.
- **F-5:** The backpressure design propagates pressure from storage to the collector but not from the collector to the agent. Agents will buffer to local disk until they fill it. §7.2 should specify the disk high-water mark and the agent's shed policy.
- **F-6:** Exactly-once semantics are claimed in the abstract but §6.1 actually describes at-least-once delivery with idempotent writes keyed on `(tenant_id, source_id, sequence)`. That is a fine design; the abstract overstates it. **Fix the claim, not the design.**
- **F-7:** No discussion of PII handling. Telemetry payloads from the mobile SDK have historically contained user emails in error strings. The design needs a redaction stage or an explicit statement that redaction remains the producer's responsibility.

### 2.3 Minor findings

- **F-8:** Figures 3 and 5 use inconsistent arrow direction conventions (data flow vs. control flow).
- **F-9:** The term "collector" is used for two different components — the edge process and the aggregation tier. Rename the latter to "aggregator" throughout.
- **F-10:** Appendix B references a benchmark harness that is not linked and appears not to exist yet.
- **F-11:** Several latency figures are quoted without percentile labels (§5.4: "latency of 40ms").

---

## 3. Suggested Concrete Artifact

To make F-1 and F-2 actionable, I suggest the design include a normative configuration example. Something along these lines would resolve most of my ambiguity about intent:

```yaml
# kestrel/tenancy/quotas.yaml — proposed normative example
apiVersion: kestrel.northwind.internal/v1
kind: TenantQuotaPolicy
metadata:
  name: default-quota-policy
  revision: 7
spec:
  defaults:
    ingestRateRps: 2500
    burstMultiplier: 3.0
    maxPayloadBytes: 262144
    onExceed: sample          # one of: shed | queue | sample
    sampleRetainRatio: 0.05
  classes:
    - name: critical          # Payments, Auth, Fraud
      ingestRateRps: 40000
      burstMultiplier: 4.0
      onExceed: queue
      queueDepthRecords: 500000
      isolation:
        dedicatedPartitions: true
        minPartitions: 24
    - name: standard
      ingestRateRps: 8000
      onExceed: sample
      isolation:
        dedicatedPartitions: false
    - name: experimental
      ingestRateRps: 500
      onExceed: shed
  cutoverGate:
    parityWindowDays: 14
    parityThreshold: 0.9995
    samplingRate: 0.0005
    samplingKey: trace_id
    owner: platform-reliability@northwind.internal
    hardStopDate: "2026-02-27"
```

The `hardStopDate` field is the important one. If dual-write has not ended by that date, the program should escalate to the architecture board automatically rather than drifting.

---

## 4. Questions for the Authors

1. What is the intended behavior when the schema registry is unavailable? §4.2 implies writes are rejected. Is that correct, and has Payments agreed to it?
2. Has anyone measured the actual p99 cost of registry validation on the hot path, or is the quoted 1.8ms an estimate? Appendix B suggests it is an estimate.
3. Why was Redpanda ruled out in §2.3? The stated reason ("operational unfamiliarity") seems weak given that two engineers on the team ran it at their previous employer.
4. Who owns agent rollout to the ~11,000 hosts still running HoloStream 2.x? Fleet Ops was not listed as a stakeholder.
5. Does the 400-day cold retention figure come from a compliance requirement or from convention? If the former, please cite the control ID.
6. What is the rollback plan if a Kestrel deployment corrupts the aggregation tier's offset state?
7. Are the four "tenant classes" in §5.1 the same as the three "service tiers" in §8? The mapping is not stated.
8. Is there a plan for cross-region replication, or is Kestrel single-region by design? §3 is ambiguous.

---

## 5. Recommended Changes

**Required before board review (blocking):**

- [ ] Add §9.5 "Decommissioning" with named owner, cutover criteria, and a hard-stop date (addresses **F-1**).
- [ ] Add per-tenant admission control to §5, including the exceed-behavior matrix (addresses **F-2**).
- [ ] Extend Table 8.1 to 36 months with low/base/high volume bands and priced retention tiers (addresses **F-3**).
- [ ] Correct the exactly-once claim in the abstract (addresses **F-6**).
- [ ] Add a PII section, even if the conclusion is "producer responsibility" (addresses **F-7**).

**Strongly recommended (non-blocking):**

- [ ] Specify field-removal rules in the schema evolution section.
- [ ] Define agent-side disk high-water mark and shed policy.
- [ ] Answer the Redpanda question in the alternatives section rather than in review comments.

**Editorial:**

- [ ] Disambiguate *collector* / *aggregator* terminology.
- [ ] Label all latency figures with percentiles.
- [ ] Publish or remove the Appendix B benchmark reference.
- [ ] Normalize figure conventions.

---

## 6. Closing Note

I want to be clear that my objections are about *program risk*, not *technical merit*. The core architecture is sound, the ingest contract is well specified, and I would be comfortable running Payments traffic through this design once isolation is addressed. My estimate is that the required changes represent **three to five days of authoring work**, not a redesign. I would be glad to co-write §9.5 if that accelerates things.

Recommend re-review on or before **4 April**.
