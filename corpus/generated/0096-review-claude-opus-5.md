# Review Summary: *Meridian Data Platform — Technical Design Document v2.3*

**Reviewer:** Dr. Alina Verhoeven, Principal Architect, Platform Reliability
**Document owner:** Kwame Osei-Bright, Staff Engineer, Ingestion Team
**Date of review:** 14 March 2031
**Document revision reviewed:** v2.3 (commit `8f4ac21`, 62 pages, 14 diagrams)
**Review outcome:** ==Approve with mandatory revisions== — do not proceed to implementation kickoff until Blocking items in Section 4 are resolved.

---

## 1. Overview and Scope of Review

This review covers the full technical design document for the Meridian Data Platform, a proposed replacement for the legacy Calliope ETL stack. The document describes a streaming-first ingestion layer, a tiered storage model, a schema registry, and a query federation service. I reviewed the document against our internal design-review checklist (RDR-07), the platform SLO catalogue, and the data-governance controls mandated by the Ravensbourne compliance program.

I read the document twice in full and spot-checked the appendices. I did **not** review the prototype code in the `meridian-spike` repository, though I did read the benchmark results reproduced in Appendix C. My comments on those numbers are therefore limited to what is presented in the document itself.

Total comments raised: **47** (11 blocking, 19 major, 17 minor). This summary consolidates them into themes rather than repeating each inline comment.

---

## 2. Summary Assessment

The design is **fundamentally sound** and represents a significant improvement over the two earlier drafts. The decision to decouple ingestion from transformation is correct, and the tiered storage proposal is well-argued. The document is unusually clear about what it is *not* doing, which I appreciate — the explicit non-goals section saved me at least an hour of speculation.

However, the document has three structural weaknesses that must be addressed before it can serve as an implementation contract:

1. **Failure semantics are under-specified.** The happy path is described in exhaustive detail; the failure paths are described in a single paragraph with the phrase "retry with backoff" doing an enormous amount of unearned work.
2. **The cost model is optimistic and unsourced.** The projected annual infrastructure spend of $412,000 is presented without derivation. My rough independent estimate lands closer to $680,000 at the stated throughput.
3. **Migration is deferred to "a future document."** Given that Calliope processes 3.1 billion events per day for 41 downstream consumers, migration is not a footnote — it is arguably the hardest part of the project.

> The most dangerous kind of design document is one that is precise about the easy parts and vague about the hard ones. This document is currently 80% of the way to being excellent, and the remaining 20% is where all the risk lives.

---

## 3. Findings by Theme

### 3.1 Architecture and Component Boundaries

*Positive:* The four-service decomposition (Intake, Normalizer, Registry, Federator) has clean boundaries. Section 3.2's argument for keeping the Registry out of the request path is convincing and well-supported by the latency budget table.

*Concerns:*

- The Normalizer is described as stateless in §3.4 but §3.9 introduces a "dedupe window" of 90 seconds, which is state.
  - This state is presumably held in memory, which means:
    - A Normalizer restart loses the dedupe window entirely.
      - Duplicates then flow downstream during a rolling deploy.
        - With 12 replicas and a 40-second drain, the document should quantify the expected duplicate volume per deploy. My estimate is 2.4M events, which is not trivial.
      - No downstream consumer is documented as idempotent.
    - Horizontal scaling requires partition affinity, which is not mentioned anywhere.
- The Federator's fan-out limit is set to 8 backends. The rationale for 8 (rather than 6 or 16) is not given.
- Diagram 7 shows a bidirectional arrow between Registry and Intake; the text describes a one-way pull. One of these is wrong.

### 3.2 Data Model and Schema Evolution

The schema registry design is the strongest section of the document. The three-tier compatibility model (strict, forward, permissive) is clearly explained, and the worked example on page 28 is excellent.

Remaining gaps:

- **Schema deletion is not addressed.** What happens when a schema is retired but historical data in cold storage still references it? The document should state whether schemas are immutable forever, or garbage-collected on some horizon.
- Field-level deprecation has no defined lifecycle. I would expect at minimum: `active → deprecated → sunset → removed`, with a documented minimum duration per stage.
- The `nullable` semantics differ subtly between the Avro-derived internal representation and the Parquet cold-storage layout. This is mentioned in a footnote but deserves a full subsection.

### 3.3 Reliability, SLOs, and Failure Modes

This is the weakest area and the source of most Blocking findings.

The document commits to a 99.95% availability target for the Intake service but never defines:

- the measurement window (rolling 30-day? calendar month?),
- what counts as an error (5xx only? or also timeouts and connection resets?),
- whether the SLO applies per-region or globally.

There is also no error budget policy. Without one, the SLO is decorative.

The proposed retry configuration is presented as pseudocode, and I want to flag a specific problem with it:

```python
def submit_batch(batch, max_attempts=5):
    delay = 0.5
    for attempt in range(max_attempts):
        try:
            return intake_client.post(batch, timeout=30)
        except TransientError:
            time.sleep(delay)
            delay *= 2
    raise IngestionFailure(batch.id)
```

Three issues with the above:

1. **No jitter.** With 12 producer replicas failing simultaneously, retries will synchronize into thundering-herd waves at t=0.5s, 1.5s, 3.5s, 7.5s, and 15.5s.
2. **The timeout exceeds the retry budget's usefulness.** Five attempts at a 30-second timeout means a worst case of ~165 seconds before `IngestionFailure` is raised, which exceeds the 60-second producer-side deadline stated in §5.1. The code and the prose contradict each other.
3. **`IngestionFailure` has no defined handler.** Is the batch dropped? Written to a dead-letter queue? The document does not say, and this is a *data-loss-shaped hole*.

### 3.4 Security and Governance

- Encryption at rest is specified for hot and warm tiers but omitted for the cold tier. I assume this is an oversight rather than a decision.
- The document says access control is "delegated to the existing IAM layer." Given that the Federator issues queries on behalf of users against multiple backends, the delegation semantics matter enormously. Does the Federator impersonate the caller, or use a service principal with broad rights? These have very different audit implications.
- PII field tagging is mentioned but there is no enforcement mechanism described — tagging without enforcement is documentation, not a control.

### 3.5 Cost and Capacity

The capacity model assumes a steady 36,000 events/second. Our Calliope telemetry shows a peak-to-mean ratio of roughly 4.2:1, with a sustained daily peak near 151,000 events/second between 09:00 and 11:00 UTC. The document should model peak, not mean.

Storage projections similarly assume a compression ratio of 6.8:1 based on a 40 GB sample. That sample was drawn from a single high-cardinality-free source. I would expect a blended ratio nearer 3.5:1.

---

## 4. Findings Register

| ID | Severity | Area | Finding |
|---|---|---|---|
| MDP-01 | Blocking | Reliability | No dead-letter path defined for exhausted retries |
| MDP-02 | Blocking | Reliability | SLO measurement window undefined; no error budget policy |
| MDP-03 | Blocking | Architecture | Normalizer described as stateless but holds dedupe state |
| MDP-04 | Blocking | Security | Cold-tier encryption at rest unspecified |
| MDP-05 | Blocking | Security | Federator delegation model ambiguous |
| MDP-06 | Blocking | Cost | Capacity model uses mean, not peak, throughput |
| MDP-07 | Blocking | Migration | No migration plan; 41 downstream consumers unaddressed |
| MDP-08 | Blocking | Data | Schema retirement lifecycle undefined |
| MDP-09 | Blocking | Reliability | Retry pseudocode contradicts stated producer deadline |
| MDP-10 | Blocking | Governance | PII tagging has no enforcement mechanism |
| MDP-11 | Blocking | Cost | Compression ratio extrapolated from unrepresentative sample |
| MDP-12 | Major | Architecture | Fan-out limit of 8 unjustified |
| MDP-13 | Major | Docs | Diagram 7 contradicts §3.6 prose |

*(Remaining 34 findings are recorded inline in the review tool and are not reproduced here.)*

---

## 5. Questions for the Author

1. Is the 90-second dedupe window a product requirement or an implementation artifact? If the former, what drove that specific number?
2. Are any of the 41 Calliope consumers already idempotent, and do we have an inventory?
3. What is the intended behaviour when the Registry is unavailable — fail closed, or fall back to last-known-good cached schemas?
4. Was a single-service (monolithic) alternative considered and rejected? Section 2 jumps straight to the four-service decomposition without showing the alternatives that were discarded.
5. Does the $412,000 figure include egress, or compute and storage only?
6. Who owns the Federator after launch? The RACI table lists the Ingestion team for three services and leaves the fourth blank.
7. Is there a hard requirement for exactly-once delivery, or is at-least-once with downstream idempotency acceptable? The document uses both phrases in different sections.

---

## 6. Recommended Changes

Ordered by priority:

1. **Add a Failure Modes section (new §6).** Enumerate at minimum: Registry unavailable, Normalizer partition loss, cold-tier write failure, Federator backend timeout, and poison-message handling. For each, state detection, mitigation, and blast radius.
2. **Rewrite §5.1 retry semantics.** Add full jitter, reconcile the timeout arithmetic with the producer deadline, and specify the dead-letter destination and its retention.
3. **Rebuild the cost model in the appendix** with peak throughput, a blended compression ratio, and explicit line items for egress and inter-AZ transfer. Show the arithmetic.
4. **Promote migration to a first-class section**, even if the detail lands in a companion document. At minimum: consumer inventory, cutover strategy (dual-write? shadow read?), and rollback criteria.
5. **Resolve the stateless/stateful contradiction** for the Normalizer and document the partition-affinity requirement.
6. **Define the schema lifecycle** including retirement, with minimum durations per stage.
7. **Correct Diagram 7** and add a diagram-to-section cross-reference table.
8. Minor: standardise on either "batch" or "envelope" throughout; both are used for the same concept.

---

## 7. Re-review Requirements

I would like to re-review the document once items 1–5 above are addressed. Items 6–8 can be verified asynchronously. I do not require a full re-read; a diff walkthrough of 30 minut
