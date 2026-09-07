# Research Notes — Ingest-Side Deduplication for the Cormorant Telemetry Pipeline

**Notebook:** HALYARD-7
**Author:** R. Ossley-Vance, Platform Reliability
**Window covered:** sprints 41–44
**Status:** draft, pending review by the Ingest guild

## Problem statement

Cormorant currently accepts ~1.9 M events/sec at peak from 34 000 edge agents. Agents retry aggressively on any 5xx or socket timeout, so between 0.4 % and 3.1 % of accepted events are duplicates of something we already stored. Downstream, the rollup service double-counts these, and the billing extract inherits the error. Our correctness target for the next release train is **≤ 1 duplicate per 10^7 stored events**, measured over a rolling 24 h window, without adding more than 6 ms to the p99 ingest latency budget (currently 41 ms, ceiling 55 ms).

Every event carries an `emit_id`: a 128-bit value the agent derives from `(agent_uuid, monotonic_seq, boot_epoch)`. It is stable across retries and unique per logical emission. Deduplication therefore reduces to membership testing over a very large, but time-bounded, key set — agents are contractually forbidden from retrying beyond 900 s, so a key older than the retention horizon can be forgotten.

Three candidate designs were prototyped. Numbers below come from the `sable-3` staging cluster (12 ingest nodes, 48 vCPU each) replaying the `oct-peak` capture at 1.4× real speed.

---

## Approach A — Centralised exact set in Tidepool

A single logical Tidepool cluster (our in-house sharded key-value store) holds `emit_id → ()` with a 900 s TTL. Each ingest worker issues a conditional insert; a rejected insert means "duplicate, drop".

**Observed behaviour**

- Duplicate escape rate: 0 in 4.1 × 10^9 replayed events. Exact, as expected.
- Added p99 latency: 11.3 ms (one extra network round trip plus tail queuing).
- Tidepool CPU at peak: 71 % of a 9-node cluster dedicated to this workload alone.
- Failure mode is ugly: when the Tidepool leader for a shard flaps, ingest workers either block (latency spike to 380 ms) or fail open (duplicates flood through in a burst of ~2.2 M).

The fail-open/fail-closed choice is the crux. We modelled both:

- **Fail closed**
    - availability becomes the product of ingest availability and Tidepool availability
    - measured composite over 30 days of staging chaos runs: 99.87 %, below our 99.95 % SLO
- **Fail open**
    - availability preserved
    - but a 40 s partition produced 1.8 × 10^6 duplicates — four orders of magnitude over budget
        - a compensating batch job could remove them post hoc
            - requires the rollup service to support retractions
                - which it does not, and the retrofit was scoped at 7 engineer-weeks

Approach A is the correctness gold standard and the operational worst case.

---

## Approach B — Partition-local cuckoo filters

Route by `hash(emit_id) mod P` so that all retries of a given emission land on the same partition, then keep an in-process cuckoo filter per partition. No network hop, no shared state.

Sizing: at 1.9 M/s and a 900 s horizon, a partition of 1/256 of the stream holds ~6.7 M live keys. A 4-way cuckoo filter with 14-bit fingerprints at 92 % load gives a false-positive rate near 1.0 × 10^-3 — far too coarse. Pushing fingerprints to 24 bits lands at ~4 × 10^-6 and costs 22 MB per partition, or 5.6 GB across the fleet. Acceptable.

A false positive here means we *drop a legitimate event*, which is worse than emitting a duplicate. That asymmetry drove the fingerprint width.

```python
# halyard/router.py — partition assignment must survive rebalance
# so that a retry reaches the same filter as the original.

RING_SLOTS = 4096

def partition_for(emit_id: bytes, ring: "Ring") -> int:
    """Rendezvous-hash emit_id onto the current ring.

    Stability property: adding or removing one node moves at most
    1/len(ring.nodes) of the keyspace, and never remaps a key
    between two nodes that both remain present.
    """
    slot = int.from_bytes(emit_id[:4], "big") % RING_SLOTS
    best_node, best_score = None, -1
    for node in ring.live_nodes():
        score = ring.mixer(node.id, slot)
        if score > best_score:
            best_node, best_score = node, score
    return best_node.partitions[slot % best_node.width]


def admit(event, filters) -> bool:
    pid = partition_for(event.emit_id, filters.ring)
    return filters[pid].insert_unique(event.emit_id)  # False => duplicate
```

**Observed behaviour**

- Duplicate escape rate: 3 in 4.1 × 10^9 (all during a deliberate node eviction).
- Legitimate-event drop rate: 2.7 × 10^-6, consistent with the filter's theoretical FPR.
- Added p99 latency: 0.9 ms.
- Rebalance is the weak point. When a node leaves, its partitions' filters are lost; the replacement starts empty and duplicates flow freely for up to 900 s.

Mitigation prototyped: checkpoint filter bitmaps to object storage every 20 s and have the successor hydrate from the last checkpoint. Hydration took 14 s for a 22 MB filter, leaving a 20–34 s duplicate window per eviction. With our observed eviction rate (~2.1/day) that is roughly 90 000 duplicates/day against a budget of ~16 000. Close, but failing.

---

## Approach C — Two-tier: coarse filter, then bounded exact check

Keep the partition-local filter from B, but treat a *hit* as "probably duplicate, verify" rather than "duplicate, drop". Verification consults a small Tidepool lookup restricted to keys the filter flagged.

Because genuine duplicates are 0.4–3.1 % of traffic and the FPR adds ~4 × 10^-6, the verification path sees roughly 3 % of events. That is ~57 K lookups/sec instead of 1.9 M — a 33× reduction in Tidepool load.

- Duplicate escape rate: 0 in 4.1 × 10^9 (steady state); 1 in 10^8 amortised across evictions, since a cold filter simply forwards more traffic to the exact tier rather than failing open.
- Legitimate-event drop rate: 0. Filter false positives are corrected by the exact check.
- Added p99 latency: 1.6 ms typical; 9.4 ms for the 3 % that verify.
- Tidepool footprint: 2 nodes instead of 9.
- Degradation under partition is *graceful*: the filter alone still catches ~97 % of duplicates, so a Tidepool outage costs us accuracy, not availability.

---

## Experiment log

- [x] Replay `oct-peak` against A, B, C at 1.4×
- [x] Measure filter FPR empirically at 14/18/24-bit fingerprints
- [x] Chaos: single-node eviction under load, 20 trials per approach
- [x] Cost model for Tidepool capacity under C
- [ ] Replay `mar-burst` (the pathological retry storm capture) — blocked on capture restoration
- [ ] Verify checkpoint hydration under simultaneous double eviction
- [ ] Confirm 24-bit fingerprint memory ceiling on the 32 GB ingest SKU
- [ ] Sign-off from Billing on residual duplicate budget

## Recommendation

1. Adopt **Approach C** as the target architecture for release 9.2.
2. Ship the partition-local filter first, behind flag `halyard.filter.enabled`, defaulting off.
3. Enable verification tier only after Tidepool capacity for 2 dedicated nodes is provisioned in both regions.
4. Instrument `dedup_verify_ratio`; alert if it exceeds 8 %, which would indicate either a retry storm or filter corruption.
5. Revisit fingerprint width once `mar-burst` results land — 20 bits may suffice given the exact backstop, saving ~1.9 GB fleet-wide.

**Open question for review:** should the verification tier be regional or global? Regional is cheaper and simpler, but agents that fail over across regions mid-retry would escape deduplication. Estimated frequency of that scenario is unknown; needs a query against the edge routing logs before we commit.
