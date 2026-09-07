# Design Review: Harbor Ingest Pipeline v2 Specification

**Document under review:** `harbor-ingest-v2-spec.md`, revision 7 (dated 14 March)
**Author:** Priya Ravensworth, Platform Data Group
**Reviewer:** Dmitri Halloway, Reliability Engineering
**Review date:** 21 March
**Verdict:** Approve with required changes (blocking items in §3)

---

## 1. Summary

The specification describes a rewrite of the Harbor ingest pipeline, replacing the current single-stage batch loader with a three-stage streaming architecture: a **receiver** tier that terminates client connections, a **normalizer** tier that applies schema coercion and enrichment, and a **committer** tier that writes to the Sedgewick columnar store. The stated goals are a reduction in p99 end-to-end latency from 42 seconds to under 4 seconds, and support for 180,000 events per second sustained, up from the current ceiling of roughly 55,000.

The document is well organized and the motivation section is persuasive. The failure taxonomy in §5 is the strongest part of the draft — it is the first time I have seen someone on this team enumerate partial-commit scenarios honestly rather than asserting they cannot happen. The capacity model in Appendix B is also credible, though it depends on an assumption about payload size distribution that I question below.

My concerns cluster in three areas: the backpressure contract between tiers is underspecified, the deduplication window is too short for the retry behavior the spec itself mandates, and the migration plan assumes a dual-write period that the Sedgewick store cannot currently sustain.

---

## 2. Findings

### 2.1 Backpressure is described but not defined

Section 4.2 states that the normalizer tier "signals saturation upstream," but never defines the signal. Is it a gRPC status code, a decrement of an advertised credit window, or simply a stalled read on the transport? Each choice has different behavior when the normalizer process is alive but wedged — the case that actually happens in production. Without a definition, the receiver tier implementers and the normalizer tier implementers will make incompatible assumptions, and we will discover this during load testing in week eleven rather than during design.

### 2.2 Deduplication window is arithmetically too small

Section 6.1 specifies a 90-second deduplication window keyed on `(tenant_id, event_uuid)`. Section 7.4 specifies a client retry policy with exponential backoff, initial delay 2 seconds, multiplier 2.0, and a maximum of 8 attempts. The worst-case elapsed time across those attempts is 2+4+8+16+32+64+128+256 = 510 seconds, ignoring request duration entirely. A client that succeeds on its final attempt will produce a duplicate that the pipeline cannot detect, because the window closed roughly seven minutes earlier.

Either the window grows to at least 600 seconds, or the retry policy caps at 4 attempts (30 seconds cumulative), or dedup moves to the committer tier where the Sedgewick primary key can enforce idempotence structurally. I prefer the third option, but it has a write-amplification cost that Appendix B does not model.

### 2.3 Dual-write migration exceeds store capacity

Section 9 proposes running the legacy loader and the v2 pipeline concurrently for six weeks, both writing to Sedgewick. Current Sedgewick ingest headroom is approximately 1.4x steady state. Dual-write requires 2.0x, plus compaction overhead the document estimates at 15% but which our own measurements from the Novemberd incident put closer to 34% under sustained write pressure. The migration as written will saturate the store.

### 2.4 Smaller findings

- §3.3 uses "eventually consistent" without specifying a bound. Suggest an explicit staleness SLO.
- §5.2 lists seven failure modes; the table omits normalizer OOM, which is the most common failure in the v1 system.
- Appendix B assumes a mean payload of 1.8 KB with a lognormal distribution. Our sampled traffic from February shows a bimodal distribution with a second mode near 46 KB driven by three tenants that batch client-side. The capacity model should be rerun against the empirical distribution.
- The term "commit" is used in §4, §6, and §8 with three different meanings (transport acknowledgment, normalizer checkpoint, and durable store write). Please disambiguate.

---

## 3. Blocking items

1. **Define the backpressure signal explicitly**, including the wedged-but-alive case and a receiver-side timeout. Add a sequence diagram.
2. **Resolve the deduplication window versus retry policy contradiction.** State the chosen approach and its cost.
3. **Revise the migration plan** to avoid concurrent full-rate dual writes, or obtain written capacity confirmation from the Sedgewick team (owner: Talia Vorstenbosch).
4. **Rerun Appendix B** against the empirical payload distribution, including the 46 KB mode.

---

## 4. Questions for the author

1. What happens to in-flight events in the normalizer when a deployment rolls? Is there a drain phase, and if so, what is its maximum duration?
2. Is `event_uuid` client-generated? If so, what is the plan for tenants that generate collisions — reject, tolerate, or namespace?
3. Does the committer tier preserve per-tenant ordering, per-partition ordering, or no ordering guarantee? §8.1 implies the first but §8.4 implies the third.
4. Why three tiers rather than two? The normalizer appears to be stateless; merging it into the receiver would remove a network hop worth roughly 1.1 ms at p50.
5. What is the rollback procedure if v2 is enabled for a tenant and produces malformed rows? Is there a per-tenant kill switch, and at which tier does it live?

---

## 5. Suggested contract sketch

To make finding 2.1 concrete, here is the shape of the credit-based contract I would like to see specified. This is illustrative, not prescriptive.

```protobuf
// Receiver <-> Normalizer flow control
message NormalizerCredit {
  uint32 available_slots   = 1;  // events the normalizer will accept now
  uint32 refresh_interval_ms = 2;  // receiver must re-request after this
  SaturationLevel level    = 3;
}

enum SaturationLevel {
  SATURATION_NORMAL     = 0;  // accept freely
  SATURATION_ELEVATED   = 1;  // shed low-priority tenants
  SATURATION_CRITICAL   = 2;  // accept only replay traffic
  SATURATION_UNRESPONSIVE = 3;  // synthesized by receiver on credit timeout
}
```

The key property is that level 3 is produced by the *receiver* when credits stop arriving, so a wedged normalizer degrades to a defined state instead of an undefined one.

---

## 6. Recommended changes (non-blocking)

- Add a glossary; the commit-overloading problem in §2.4 would disappear.
- Move the failure taxonomy from §5 to §2 — it motivates the architecture better than the current prose does.
- Include a per-tier resource budget table (CPU, memory, network) so capacity planning is reviewable independently of Appendix B.
- Specify metric names and cardinality limits now, before implementation invents them.
- Add an explicit non-goal section. I suspect exactly-once delivery is a non-goal, but the document never says so, and readers will assume otherwise.

---

**Next step:** Revision 8 addressing §3, then a 45-minute synchronous review with Reliability and the Sedgewick team before implementation begins.
