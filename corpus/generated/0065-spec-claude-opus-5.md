# Orbweaver — Distributed Rate-Limit Coordination Service

**Spec ID:** OW-SPEC-0042
**Version:** 0.4.1 (draft)
**Status:** Review — targeting freeze on 2026-02-13
**Owners:** Traffic Platform Guild (`#guild-traffic`), primary author M. Ferreiro-Blount
**Reviewers:** Edge Runtime, Billing Integrations, Security Assurance

---

## 1. Overview

Orbweaver is an internal service that coordinates request quotas across geographically distributed enforcement points. Today each edge node ("spinneret") maintains an independent token bucket, which causes aggregate overshoot of up to 6.4× the configured limit when traffic fans out across all eleven points of presence. Orbweaver replaces per-node isolation with a **lease-based allocation model**: spinnerets borrow slices of a global budget for short windows, enforce locally, and settle usage asynchronously.

The service is *not* a general-purpose distributed lock manager, a billing meter of record, or an authorization system. Enforcement decisions remain in the data plane; Orbweaver only distributes capacity.

### 1.1 Goals

- Bound global overshoot to ≤ 3% of the configured limit for any policy under steady traffic.
- Keep the p99 in-path enforcement cost at or below 180 µs (local decision, no network hop).
- Survive total loss of the coordination tier with graceful, predictable degradation.
- Support policy reconfiguration that takes effect at all spinnerets within 5 seconds.

### 1.2 Non-goals

- Sub-request-level fairness between individual tenants sharing a policy.
- Retroactive quota enforcement or clawback of already-served requests.
- Exact accounting suitable for invoicing (Billing Integrations owns that pipeline).

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Policy** | A named rule binding a subject selector to a rate (e.g. `4500 req / 60 s`). |
| **Subject** | The entity being limited: an API key, tenant ID, or source prefix. |
| **Spinneret** | An enforcement process embedded in an edge proxy. |
| **Lease** | A time-boxed grant of N units of a policy's budget to one spinneret. |
| **Settlement** | The periodic report of consumed units back to the coordinator. |
| **Web** | A shard of the coordinator responsible for a hash range of subjects. |

---

## 3. Functional Requirements

**FR-1.** The system SHALL allow creation, update, and deletion of policies through a versioned HTTP API. Policy identifiers are opaque strings of 4–96 characters matching `^[a-z0-9][a-z0-9._-]*$`.

**FR-2.** A policy SHALL support at minimum: a `limit` (integer units), a `window_ms` (250–3,600,000), and a `burst_ratio` (1.0–4.0) that permits short-term overdraw against future windows.

**FR-3.** Spinnerets SHALL acquire leases via a single bidirectional stream per coordinator shard. A lease request MAY cover multiple subjects in one frame; the batch limit is 512 subjects.

**FR-4.** A lease SHALL carry an explicit `expires_at` timestamp. Units in an expired lease revert to the global pool without requiring settlement.

**FR-5.** The coordinator SHALL implement *demand-proportional allocation*: when total requested units exceed the remaining budget, each requester receives a share proportional to its observed consumption rate over the previous three windows, floored at one unit.

**FR-6.** Settlement reports SHALL be idempotent, keyed by `(lease_id, sequence)`. Duplicate sequences are discarded silently.

**FR-7.** When a spinneret cannot reach any coordinator shard, it SHALL enter **autarky mode**: it continues enforcing against its last known lease rate, decayed by 15% per elapsed window, with a hard floor of 2% of the policy limit. Autarky mode SHALL be reported in telemetry within one window.

**FR-8.** The system SHALL expose a read-only inspection endpoint returning the current global consumption and per-spinneret allocations for a given subject, with a staleness bound of 2 seconds.

**FR-9.** Policy changes SHALL be propagated over the same stream as leases, as a `PolicyEpoch` frame. Spinnerets SHALL reject leases whose epoch is lower than their current epoch.

**FR-10.** Deletion of a policy SHALL be a soft delete with a 24-hour tombstone; enforcement stops immediately but the identifier cannot be reused during that window.

---

## 4. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | In-path decision latency (local, cached lease) | p50 ≤ 22 µs, p99 ≤ 180 µs |
| NFR-2 | Lease acquisition round trip, same region | p99 ≤ 9 ms |
| NFR-3 | Coordinator availability | 99.95% monthly |
| NFR-4 | Global overshoot, steady state | ≤ 3% |
| NFR-5 | Global overshoot, during shard failover | ≤ 18% for ≤ 30 s |
| NFR-6 | Policy propagation | ≤ 5 s to 99% of spinnerets |
| NFR-7 | Sustained coordinator throughput per shard | 140,000 lease ops/s |
| NFR-8 | Memory per active subject | ≤ 512 B |

Capacity planning assumes 24 shards per region, 3 regions, and a working set of 4.1 million active subjects.

---

## 5. Data Model

```protobuf
syntax = "proto3";
package orbweaver.v1;

message Policy {
  string   id            = 1;   // stable identifier
  uint64   limit         = 2;   // units per window
  uint32   window_ms     = 3;   // 250 .. 3600000
  float    burst_ratio   = 4;   // 1.0 .. 4.0
  Selector selector      = 5;
  uint64   epoch         = 6;   // monotonic, coordinator-assigned
  string   description   = 7;
}

message Selector {
  enum Kind { SUBJECT_KIND_UNSET = 0; API_KEY = 1; TENANT = 2; PREFIX = 3; }
  Kind            kind    = 1;
  repeated string include = 2;  // glob patterns, max 64
  repeated string exclude = 3;
}

message LeaseRequest {
  string spinneret_id = 1;
  uint64 policy_epoch = 2;
  repeated Ask asks   = 3;      // max 512

  message Ask {
    string policy_id  = 1;
    string subject    = 2;
    uint64 want_units = 3;      // desired grant
    uint64 spent      = 4;      // consumed since last settlement
  }
}

message Lease {
  string lease_id     = 1;
  string policy_id    = 2;
  string subject      = 3;
  uint64 units        = 4;
  int64  expires_at   = 5;      // unix millis
  uint32 refresh_ms   = 6;      // hint: reacquire after this delay
}

message LeaseResponse {
  repeated Lease leases   = 1;
  repeated Denial denials = 2;
  uint64 policy_epoch     = 3;

  message Denial {
    string subject = 1;
    string reason  = 2;         // "exhausted" | "unknown_policy" | "tombstoned"
    uint32 retry_after_ms = 3;
  }
}
```

---

## 6. API Sketch

### 6.1 Control plane (HTTP/1.1 + JSON, base path `/v1`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/policies` | Create a policy. Returns `201` with assigned epoch. |
| `GET` | `/v1/policies/{id}` | Fetch a policy. Supports `If-None-Match`. |
| `PATCH` | `/v1/policies/{id}` | Partial update; bumps epoch. Requires `If-Match`. |
| `DELETE` | `/v1/policies/{id}` | Soft delete, 24 h tombstone. |
| `GET` | `/v1/policies` | List, cursor-paginated, `page_size` ≤ 200. |
| `GET` | `/v1/subjects/{policy_id}/{subject}` | Inspect live consumption. |
| `POST` | `/v1/simulate` | Dry-run a policy against a replayed traffic sample. |
| `GET` | `/v1/health/shards` | Per-shard leader, lag, and lease count. |

Example creation:

```http
POST /v1/policies HTTP/1.1
Content-Type: application/json
Idempotency-Key: 8f2c-remit-4471

{
  "id": "public-search-tier2",
  "limit": 4500,
  "window_ms": 60000,
  "burst_ratio": 1.75,
  "selector": {
    "kind": "TENANT",
    "include": ["tier2-*"],
    "exclude": ["tier2-internal-fixture"]
  },
  "description": "Search fan-out cap for tier-2 tenants"
}
```

Response `201 Created`:

```json
{
  "id": "public-search-tier2",
  "epoch": 17,
  "created_at": "2026-01-19T11:04:38.221Z",
  "etag": "W/\"epoch-17\""
}
```

### 6.2 Data plane (gRPC)

```
service Coordinator {
  rpc Coordinate(stream L
