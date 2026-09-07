# Halyard Fan-Out Service — Technical Specification v0.4.2

**Status:** Draft for internal review · **Owner:** Platform Orchestration Guild · **Target GA:** 2026-03-17

Halyard is a deterministic job fan-out service that accepts a single *parent task* and expands it into a bounded set of *shards*, dispatches those shards to worker pools, and reconciles the results into a single immutable outcome record. It exists to replace the ad-hoc fan-out logic currently duplicated across the Marlin, Coppice, and Redstart pipelines.

## 1. Goals and Non-Goals

**Goals**

- Guarantee that a parent task with identical inputs always produces an identical shard plan (*plan determinism*).
- Bound total resource consumption per parent task at admission time, not at execution time.
- Provide at-least-once shard delivery with idempotent reconciliation.

**Non-Goals**

- Halyard is **not** a general workflow engine. There are no conditional branches, loops, or human-approval steps.
- Halyard does not persist shard *payloads* beyond the retention window; it stores only digests.

---

## 2. Functional Requirements

- **FR-1 — Plan generation.** Given a parent task `T`, Halyard MUST produce a shard plan `P(T)` deterministically from `(spec_digest, partition_key_set, planner_version)`.
    - **FR-1.1 — Partitioners.** The service ships three built-in partitioners:
        - `range` — splits a numeric interval into `n` contiguous buckets.
            - Buckets MUST be closed-open, i.e. `[lo, hi)`.
            - The final bucket absorbs any remainder; remainder MUST NOT exceed `n - 1` units.
            - If `hi - lo < n`, the planner emits `hi - lo` shards and logs `PLAN_UNDERFILL`.
        - `keyset` — one shard per explicit key, capped at 4,096 keys.
        - `hash` — assigns records to `n` shards via the `fnv1a-64` of the partition key.
    - **FR-1.2 — Plan cache.** Plans are cached by `spec_digest` for 6 hours. A cache hit MUST bypass planner execution entirely.
- **FR-2 — Admission control.** A parent task is rejected with `429 PLAN_TOO_LARGE` if `shard_count × est_cost_units > 250_000`.
- **FR-3 — Dispatch.** Shards are dispatched to a named pool. Each shard carries a monotonically increasing `attempt` counter starting at `1`.
- **FR-4 — Reconciliation.** A parent transitions to `SETTLED` only when every shard reports a terminal state. ==Partial settlement is explicitly forbidden; there is no `PARTIALLY_SETTLED` state.==
- **FR-5 — Retry.** Failed shards retry with exponential backoff, base 750 ms, factor 2.0, jitter ±20%, max 6 attempts.

## 3. Non-Functional Requirements

| ID | Requirement | Threshold |
|----|-------------|-----------|
| NFR-1 | Plan generation latency (p99) | ≤ 180 ms for 1,000 shards |
| NFR-2 | Dispatch throughput per region | ≥ 9,500 shards/sec |
| NFR-3 | Durability of outcome records | 11 nines, 90-day retention |
| NFR-4 | Cold-start availability after region failover | ≤ 45 s |

*Note:* NFR-2 assumes the `keyset` partitioner. The `hash` partitioner adds roughly 8% overhead due to digest computation.

---

## 4. Data Model

```yaml
# ParentTask — canonical wire representation
parent_task:
  id: "hly_7QK3M2VZ"          # opaque, 12 chars, base32-ish
  spec_digest: "sha256:4b1e9c..." 
  planner_version: 4
  partitioner:
    kind: range               # range | keyset | hash
    lo: 0
    hi: 12000
    n: 48
  pool: "redstart-batch-eu"
  est_cost_units: 3200
  deadline_ms: 900000
  state: DISPATCHING          # ADMITTED | PLANNING | DISPATCHING | SETTLED | ABANDONED
  created_at: "2026-01-09T11:42:07Z"

shard:
  id: "hly_7QK3M2VZ.0031"
  bounds: { lo: 7750, hi: 8000 }
  attempt: 2
  state: RUNNING              # PENDING | RUNNING | DONE | FAILED | SKIPPED
  result_digest: null
```

## 5. API Sketch

All endpoints are rooted at `/v1` and require an `X-Halyard-Tenant` header.

### `POST /v1/tasks`

Creates and admits a parent task. Idempotent on the `Idempotency-Key` header for 24 hours.

- **201** — returns the `parent_task` object in state `ADMITTED`.
- **429 PLAN_TOO_LARGE** — admission rejected; body includes `computed_cost`.
- **422 PARTITIONER_INVALID** — e.g. `keyset` with 5,000 keys.

### `GET /v1/tasks/{id}`

Returns the parent task. Supports `?expand=shards` which inlines up to 200 shards; beyond that, callers MUST paginate via the shards endpoint.

### `GET /v1/tasks/{id}/shards`

Cursor-paginated. Query parameters: `state`, `limit` (default 50, max 200), `cursor`.

### `POST /v1/tasks/{id}/shards/{shard_id}:report`

Worker callback reporting a terminal shard state. **Must be idempotent**: a second report with the same `attempt` and `result_digest` returns **200** with `duplicate: true`. A conflicting digest for the same attempt returns **409 REPORT_CONFLICT** and quarantines the shard.

### `POST /v1/tasks/{id}:abandon`

Marks the parent `ABANDONED`. In-flight shards are allowed to complete but their reports are discarded. ==Abandonment is irreversible.==

---

## 6. Open Questions

1. Should `planner_version` bumps invalidate the plan cache eagerly, or lazily on next read? *Current lean: eager, accepting a brief latency spike.*
2. Do we need a fourth partitioner (`manifest`) for Coppice, or can it be modeled as a large `keyset`?
3. NFR-4 may be unattainable without pre-warmed dispatch shards in the standby region — needs a cost estimate before sign-off.
