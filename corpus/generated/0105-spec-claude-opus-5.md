# Kestrel Ledger Sync — Technical Specification v0.4

**Status:** Draft for internal review
**Owner:** Platform Data Group
**Last revised:** 2031-03-14

---

## 1. Overview

Kestrel Ledger Sync (KLS) is a replication service that keeps append-only transaction ledgers consistent across geographically separated regions. Each region maintains an authoritative *shard set*, and KLS propagates committed segments between shards using a pull-based reconciliation protocol with bounded staleness guarantees.

The service replaces the legacy `driftpipe` batch exporter, which required a nightly maintenance window and could not express partial-segment recovery. KLS targets **sub-90-second convergence** for 99% of segments under normal network conditions.

> Design principle: a replica that cannot prove it is current must announce that it is stale. Silent divergence is treated as a data-loss event and is escalated immediately, not repaired in the background.

## 2. Scope

In scope:

- Segment-level replication between named regions.
- Conflict detection via monotonic segment fences.
- Operator-facing status and repair endpoints.
- Backpressure signalling to upstream writers.

Out of scope:

- Schema migration of ledger payloads (handled by Loomwright).
- Cross-region authorization policy (delegated to the Halyard token service).
- Cold archival to object storage.

## 3. Definitions

| Term | Meaning |
|---|---|
| **Segment** | An immutable batch of 1–4096 ledger entries sealed by a writer. |
| **Fence** | A monotonically increasing 64-bit integer assigned per shard at seal time. |
| **Convergence lag** | Wall-clock delta between a segment's seal time and its durable acceptance at all subscribed replicas. |
| *Quarantine* | State applied to a segment whose checksum or fence ordering fails validation. |
| **Cohort** | A named group of replicas that must converge together before a segment is acknowledged. |

## 4. Functional Requirements

### 4.1 Replication

- **R-101** — The service SHALL replicate sealed segments from a source shard to every replica in the declared cohort.
- **R-102** — The service SHALL NOT replicate unsealed segments under any condition, including operator override.
- **R-103** — Each replica SHALL validate the segment checksum (BLAKE3-256, truncated to 128 bits) before durable write.
- **R-104** — On checksum failure, the replica SHALL quarantine the segment and emit a `segment.quarantined` event within 2 seconds.
- **R-105** — The service SHALL support at most 12 replicas per cohort. Requests declaring more SHALL be rejected with `COHORT_TOO_LARGE`.

### 4.2 Ordering and Fences

- **R-201** — Fences SHALL be strictly increasing per shard. A segment arriving with a fence lower than or equal to the replica's high-water mark SHALL be discarded as a duplicate.
- **R-202** — A gap in fence numbering SHALL trigger a *backfill request* to the source shard rather than a stall.
- **R-203** — Backfill requests SHALL be rate-limited to 40 per minute per replica pair.

### 4.3 Staleness and Health

- **R-301** — Each replica SHALL publish a staleness estimate at least every 5 seconds.
- **R-302** — A replica whose convergence lag exceeds ==180 seconds== SHALL transition to `DEGRADED` and refuse read traffic tagged `consistency=strict`.
- **R-303** — A replica in `DEGRADED` for more than 15 minutes SHALL be automatically evicted from its cohort and flagged for operator review.

### 4.4 Backpressure

- **R-401** — When any cohort member reports a lag above 120 seconds, the coordinator SHALL emit a `slow_cohort` advisory to upstream writers.
- **R-402** — Writers receiving `slow_cohort` SHOULD reduce seal frequency but SHALL NOT be blocked by KLS.

## 5. Non-Functional Requirements

- **N-01** — p99 convergence lag ≤ 90 s at 3,200 segments/minute aggregate.
- **N-02** — Coordinator memory footprint ≤ 1.5 GiB per 10,000 tracked segments.
- **N-03** — Cold start to first successful replication ≤ 25 s.
- **N-04** — All inter-region traffic encrypted; plaintext transport is a hard failure, not a warning.
- **N-05** — Availability target of 99.95% measured monthly against the `/v1/health` endpoint.

---

## 6. Architecture Sketch

Three components:

1. **Coordinator** — maintains cohort membership, fence high-water marks, and staleness estimates. Stateless across restarts except for a compacted fence journal.
2. **Puller** — one per replica; opens a long-lived stream to each source shard and requests segments by fence range.
3. **Warden** — validation and quarantine handling; runs in-process with the Puller but with a separate thread budget.

The coordinator never touches segment payloads. This is deliberate: *payload-blind coordination* keeps the control plane small enough to reason about and avoids a second copy of ledger data in a component that is not durability-hardened.

```python
from dataclasses import dataclass
from typing import Iterator

@dataclass(frozen=True)
class SegmentRef:
    shard_id: str
    fence: int
    entry_count: int
    checksum: bytes  # 16 bytes, truncated BLAKE3

class Puller:
    MAX_RANGE = 256

    def __init__(self, replica_id: str, hwm: int) -> None:
        self.replica_id = replica_id
        self.high_water_mark = hwm

    def plan(self, available: list[SegmentRef]) -> Iterator[tuple[int, int]]:
        """Yield (start_fence, end_fence) ranges to request, in order."""
        pending = sorted(
            s.fence for s in available if s.fence > self.high_water_mark
        )
        if not pending:
            return
        start = prev = pending[0]
        for fence in pending[1:]:
            contiguous = fence == prev + 1
            room = fence - start < self.MAX_RANGE
            if contiguous and room:
                prev = fence
                continue
            yield (start, prev)
            start = prev = fence
        yield (start, prev)

    def accept(self, ref: SegmentRef, verified: bool) -> str:
        if not verified:
            return "QUARANTINE"
        if ref.fence <= self.high_water_mark:
            return "DUPLICATE"
        self.high_water_mark = ref.fence
        return "ACCEPTED"
```

---

## 7. API Sketch

All endpoints are rooted at `https://kls.internal/v1`. Authentication uses Halyard bearer tokens with the `kls.operate` or `kls.read` scope.

### 7.1 `GET /cohorts/{cohort_id}`

Returns membership and aggregate health.

**Response 200**

```json
{
  "cohort_id": "atlas-north",
  "members": [
    {"replica_id": "rp-4471", "state": "HEALTHY", "lag_seconds": 6.2, "hwm": 918442},
    {"replica_id": "rp-4472", "state": "DEGRADED", "lag_seconds": 214.9, "hwm": 916003}
  ],
  "worst_lag_seconds": 214.9,
  "advisory": "slow_cohort"
}
```

### 7.2 `POST /cohorts/{cohort_id}/members`

Adds a replica. Idempotent on `replica_id`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `replica_id` | string | yes | Must match `^rp-[0-9]{4,6}$` |
| `initial_hwm` | integer | no | Defaults to `0` (full backfill) |
| `priority` | string | no | `normal` \| `deferred` |

**Errors:** `COHORT_TOO_LARGE` (409), `REPLICA_UNREACHABLE` (424), `INVALID_HWM` (400).

### 7.3 `GET /replicas/{replica_id}/segments`

Query parameters: `from_fence` (int), `limit` (int, ≤ 256), `state` (`accepted` | `quarantined` | `pending`).

Returns a fence-ordered page with an opaque `next_cursor`.

### 7.4 `POST /replicas/{replica_id}/backfill`

Requests a fence range explicitly. Subject to **R-203** rate limits; exceeding returns `429` with a `Retry-After` header.

```json
{ "start_fence": 916004, "end_fence": 916260, "reason": "operator_repair" }
```

### 7.5 `POST /segments/{shard_id}/{fence}/release`

Releases a quarantined segment after manual verification. Requires `kls.operate` and an `X-Justification` header of at least 20 characters. **Every release is audit-logged with the caller identity and justification text.**

### 7.6 `GET /health`

Returns `{"ok": true, "coordinator_uptime_s": 41822}` or a 503 with a failure reason.

---

## 8. Error Model

All errors share one envelope:

```json
{
  "error": {
    "code": "INVALID_HWM",
    "message": "initial_hwm exceeds source shard high-water mark",
    "retryable": false,
    "trace_id": "9c1f-4d20-bb73"
  }
}
```

Clients SHOULD retry only when `retryable` is `true`, using exponential backoff starting at 400 ms with full jitter and a ceiling of 30 s.

---

## 9. Delivery Checklist

- [x] Fence journal format frozen
- [x] Coordinator membership API implemented
- [x] Checksum validation in Warden
- [x] Load test at 3,200 segments/minute
- [ ] Automatic cohort eviction (**R-303**)
- [ ] `slow_cohort` advisory propagation to writers
- [ ] Quarantine release audit sink
- [ ] Chaos suite: partial-segment truncation
- [ ] Runbook for cross-region fence divergence

## 10. Open Questions

1. Should `deferred` priority replicas count toward the 12-member cohort limit? Current assumption: **yes**.
2. Is a 128-bit truncated checksum sufficient for shards exceeding 40 million segments, or should we widen to 192 bits before general availability?
3. Do we need a distinct state between `HEALTHY` and `DEGRADED` for replicas that are catching up but trending correctly?
