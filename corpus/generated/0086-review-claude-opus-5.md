# Review Summary: "Adaptive Cache Warming for Tiered Object Storage" (Draft v0.7)

**Reviewer:** M. Okonjo-Rasmussen, Platform Reliability
**Date:** 14 March
**Document owner:** Priya Vaidyanathan
**Status:** Revise and resubmit — recommend a second review round before design sign-off

---

## Overview

The document proposes a predictive cache-warming layer ("Kettle") that sits between the Halberd object store and the regional read caches. The stated goal is to reduce p99 cold-read latency from 840 ms to under 250 ms for the twelve highest-traffic tenants, at an incremental infrastructure cost of no more than $34,000 per quarter.

The proposal is well-organized and the problem framing in §2 is the strongest part of the draft. The author clearly establishes that cold reads cluster around predictable events (nightly batch imports, Monday-morning dashboard loads, and the quarterly reconciliation window). The decision to prefetch on a per-tenant schedule rather than a global heuristic is well-justified.

However, the draft is not yet ready for approval. The evaluation section rests on a single week of production traces, the failure-mode analysis omits the case that most concerns me (prefetch storms during regional failover), and the cost model appears to double-count storage that is already committed under the existing reservation.

---

## Findings

### F1 — Evaluation window is too narrow (blocking)

§6.2 reports a 71% cache hit-rate improvement based on traces captured between 3 and 9 February. That week overlapped the Vendrell migration, during which roughly 40% of normal write traffic was suspended. The measured hit-rate is therefore likely optimistic. I would expect the true improvement to fall in the 45–60% range once ordinary write-invalidations resume.

### F2 — Prefetch storm during failover is unaddressed (blocking)

If the `eu-north-2` region drops out, all of its tenants are rehomed to `eu-west-1`. Under the current design, each rehomed tenant triggers a full warm cycle on arrival. With 340 tenants and an average warm set of 1.8 GB, that is roughly 612 GB of simultaneous prefetch against an origin that is already absorbing displaced read traffic. §7 does not mention this scenario.

### F3 — Cost model double-counts reserved capacity (major)

Table 4 lists $19,200/quarter for "warm tier storage." My understanding is that the warm tier already runs at 38% utilization against a three-year reservation that we pay for regardless. If so, the marginal cost is closer to $4,000/quarter for the overflow above the reservation ceiling, and the headline figure should be restated.

### F4 — Eviction interaction is under-specified (major)

The design places warmed objects in the same LRU pool as demand-loaded objects. If a warm cycle loads 1.8 GB into a 2.2 GB pool, it will evict objects that are actively being read. §5.4 hints at a "warm priority bit" but never defines its semantics.

### F5 — Metrics are defined but not instrumented (minor)

§8 lists four SLIs but does not say which are already emitted. Based on my reading of the collector config, `kettle_warm_cycle_duration` and `kettle_prefetch_bytes` do not currently exist.

### F6 — Terminology drift (minor)

The terms "warm set," "prefetch set," and "candidate set" appear to describe the same concept in §3, §5, and Appendix B respectively.

---

## Questions for the Author

1. Can you re-run the §6.2 evaluation against a control week — I suggest 20–26 January — and report both figures side by side?
2. What is the intended backpressure mechanism when the origin returns 503 during a warm cycle? Does the cycle abort, retry with jitter, or degrade to partial warming?
3. Is the 250 ms p99 target measured at the client edge or at the cache boundary? Table 2 and §9 seem to disagree.
4. Who owns the tenant-schedule configuration once this ships — the platform team or each tenant's onboarding engineer?
5. Has Legal reviewed the retention implications of keeping warmed copies for tenants in the restricted-residency group?

---

## Recommended Changes

Please make the following before the next review:

- **Add §7.4, "Failover and Rehoming."** Include a rate limiter on warm cycles with a documented global ceiling. My suggestion is a token bucket sized to roughly 8% of origin read capacity.
- **Restate Table 4** with marginal cost, and add a footnote naming the reservation it draws against.
- **Define the warm priority bit fully** in §5.4: how it is set, how it decays, and whether a warmed-then-read object graduates to normal priority.
- **Add a control-week comparison** to §6.2 and revise the abstract's headline number accordingly.
- **Normalize terminology** to "warm set" throughout, and add it to the glossary.
- **Add an instrumentation checklist** to §8 marking each SLI as existing, planned, or blocked.

### Suggested configuration sketch

To make F2 and F4 concrete, I would find something like this in Appendix C helpful:

```yaml
kettle:
  warm_cycle:
    max_concurrent_tenants: 12
    per_tenant_bytes_per_sec: 40_000_000
    global_ceiling_bytes_per_sec: 900_000_000
    abort_on_origin_5xx_ratio: 0.05
    retry:
      strategy: exponential_jitter
      base_ms: 400
      max_attempts: 4
  eviction:
    pool: shared_lru
    warm_priority:
      enabled: true
      initial_weight: 0.35
      decay_half_life_sec: 1800
      graduate_on_demand_read: true
  failover:
    rehome_warm_delay_sec: 900
    rehome_max_concurrent_tenants: 3
```

The specific numbers are illustrative; the point is that each knob in F2 and F4 should have a named default and an owner.

---

## Overall Assessment

The core idea is sound and I support pursuing it. The gaps are concentrated in evaluation rigor and failure-mode coverage rather than in the fundamental approach, which suggests a revision cycle of one to two weeks rather than a redesign. I am happy to pair on the failover section if that would be faster than another async round.
