# Technical Specification: Vortane Rate Limiter Service (VRLS)

**Document Version:** 1.4.0
**Status:** Draft
**Author:** Systems Architecture Group, Project Halyard

## 1. Overview

The Vortane Rate Limiter Service (VRLS) is a distributed token-bucket rate limiting system designed to protect the Halyard API gateway from traffic bursts and abusive clients. VRLS operates as a sidecar process that intercepts requests before they reach upstream services, applying configurable quotas per client, per route, and per organization tier.

This document describes the functional requirements, data model, algorithmic foundation, and public API surface for VRLS version 2.

> [!note]
> VRLS is intended to run alongside the Kestrel Gateway (v3.2+). Standalone deployments are not officially supported in this release cycle.

## 2. Goals and Non-Goals

### 2.1 Goals

1. Provide sub-millisecond rate limit decisions for 99.9% of requests.
2. Support hierarchical quota policies (organization → team → individual client).
3. Allow dynamic reconfiguration of limits without service restart.
4. Expose a gRPC and REST-compatible API for external policy management.
5. Maintain accurate token accounting even under network partition (best-effort reconciliation).

### 2.2 Non-Goals

- VRLS does not perform authentication or authorization; it assumes an upstream identity token has already been validated.
- VRLS does not provide payload inspection or content-based throttling.
- Long-term historical analytics (beyond 30 days) are out of scope; that responsibility belongs to the Marrow telemetry pipeline.

## 3. Algorithmic Foundation

VRLS uses a variant of the token bucket algorithm augmented with a decay-weighted penalty term for repeat offenders. Each client $c$ is assigned a bucket capacity $B_c$ and a refill rate $r_c$ (tokens per second).

The number of tokens available at time $t$ for client $c$, denoted $T_c(t)$, is computed as:

$$
T_c(t) = \min\Big(B_c,\; T_c(t_0) + r_c \cdot (t - t_0) - \sum_{i} \lambda_i \, e^{-\alpha (t - t_i)}\Big)
$$

where $t_0$ is the last update timestamp, $\lambda_i$ is the penalty weight of the $i$-th violation, $\alpha$ is the decay constant (default $\alpha = 0.15$), and $t_i$ is the timestamp of the $i$-th violation event.

A request is admitted if and only if $T_c(t) \geq 1$, at which point one token is deducted. If $T_c(t) < 1$, the request is rejected with HTTP status `429` and a `Retry-After` header computed as $\lceil (1 - T_c(t)) / r_c \rceil$ seconds.

## 4. System Architecture

The VRLS deployment topology consists of the following components:

- **Edge Node** — intercepts inbound requests and performs local token bucket checks using an in-memory cache.
    - **Local Cache Layer**
        - LRU eviction with a default capacity of 250,000 entries
        - Write-through synchronization to the Coordinator every 500ms
            - Batched updates are compressed using zstd level 3
            - Failed batch writes are retried with exponential backoff (base 200ms, max 5 retries)
- **Coordinator** — maintains the authoritative state for cross-node reconciliation.
- **Policy Store** — a versioned key-value store (backed by etcd) holding rate limit policies.
- **Admin API** — the control plane surface described in Section 6.

```yaml
# vrls-config.yaml — sample deployment configuration
edge:
  cache_capacity: 250000
  sync_interval_ms: 500
  compression: zstd
  compression_level: 3

coordinator:
  replicas: 3
  quorum_size: 2
  reconciliation_interval_ms: 1000

policy_store:
  backend: etcd
  endpoints:
    - "etcd-01.internal.halyard:2379"
    - "etcd-02.internal.halyard:2379"
    - "etcd-03.internal.halyard:2379"
  namespace: "/vrls/policies"

defaults:
  bucket_capacity: 120
  refill_rate: 20
  penalty_decay_alpha: 0.15
```

> [!warning]
> Setting `reconciliation_interval_ms` below 250 has been observed to cause coordinator CPU saturation under loads exceeding 40,000 requests/sec in the Fenwick load-test cluster. Do not lower this value in production without capacity review.

## 5. Data Model

### 5.1 Policy Object

A policy defines the quota parameters for a scope (organization, team, or client).

| Field | Type | Description |
|---|---|---|
| `policy_id` | string (UUID) | Unique identifier for the policy |
| `scope` | enum | One of `org`, `team`, `client` |
| `bucket_capacity` | integer | Maximum token capacity |
| `refill_rate` | float | Tokens refilled per second |
| `penalty_alpha` | float | Decay constant for penalty term |
| `created_at` | timestamp | ISO-8601 creation time |
| `revision` | integer | Monotonically increasing revision number |

### 5.2 Violation Record

Each violation is logged with the following nested structure:

- Violation Record
    - `client_id`: string
    - `timestamp`: ISO-8601 string
    - `context`
        - `route`: string
        - `method`: string
        - `region`
            - `code`: string (e.g. `"eu-west-3"`)
            - `latency_ms`: float

## 6. API Sketch

The Admin API is exposed over REST at `/v2/admin` and mirrored via gRPC on port `7443`.

### 6.1 Endpoints

1. `GET /v2/admin/policies` — list all policies, paginated.
2. `POST /v2/admin/policies` — create a new policy.
3. `PUT /v2/admin/policies/{policy_id}` — update an existing policy (creates new revision).
4. `DELETE /v2/admin/policies/{policy_id}` — soft-delete a policy.
5. `GET /v2/admin/clients/{client_id}/status` — retrieve current token status for a client.
6. `POST /v2/admin/clients/{client_id}/reset` — forcibly reset a client's bucket to full capacity.

### 6.2 Example Request/Response

```json
{
  "policy_id": "8f14e45f-ceea-4b19-8b1a-1c0f2f1e5b3d",
  "scope": "team",
  "bucket_capacity": 300,
  "refill_rate": 45.0,
  "penalty_alpha": 0.12,
  "created_at": "2024-11-03T18:22:41Z",
  "revision": 3
}
```

### 6.3 gRPC Service Definition (excerpt)

```protobuf
service PolicyAdmin {
  rpc GetPolicy (PolicyRequest) returns (PolicyResponse);
  rpc CreatePolicy (CreatePolicyRequest) returns (PolicyResponse);
  rpc UpdatePolicy (UpdatePolicyRequest) returns (PolicyResponse);
  rpc ResetClientBucket (ResetRequest) returns (ResetResponse);
}

message PolicyRequest {
  string policy_id = 1;
}
```

## 7. Failure Modes and Recovery

If the Coordinator becomes unreachable, Edge Nodes fall back to locally cached policy values and continue enforcing limits using the last-known-good state. Once connectivity is restored, the reconciliation protocol performs a three-way merge between local counters, giving precedence to the highest observed token deficit (i.e., the most conservative estimate).

As noted in the original design review:

> The purpose of degraded-mode operation is not to guarantee correctness, but to guarantee that no client can exceed its quota by more than one reconciliation window. Perfect accuracy under partition is explicitly not a design goal.
> — Fenwick load-test cluster postmortem, Incident VR-0092

## 8. Implementation Checklist

- [x] Token bucket core algorithm implemented and unit tested
- [x] Decay-weighted penalty term validated against synthetic traffic
- [x] Edge Node local cache with LRU eviction
- [x] zstd compression for batched sync writes
- [ ] Coordinator quorum failover integration tests
- [ ] Admin API gRPC surface complete parity with REST
- [ ] Policy Store migration tooling for etcd schema v2
- [ ] Load test at 100,000 req/sec sustained for 24 hours
- [ ] Documentation for third-party policy plugin authors

## 9. Open Questions

1. Should penalty decay constants be configurable per-scope rather than globally?
2. Is a 30-day retention window sufficient for compliance audits requested by the Marrow team?
3. Should the Admin API support bulk policy import via CSV in addition to JSON?

## 10. Appendix: Glossary

- **Bucket** — the abstract container representing a client's available request quota.
- **Reconciliation Window** — the interval during which Edge Node and Coordinator states may diverge before being merged.
- **Quorum Size** — minimum number of Coordinator replicas required to accept a write.
