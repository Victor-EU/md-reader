# Kestrel Throttle Service — Technical Specification v0.9

## 1. Overview

Kestrel is a distributed rate-limiting service designed to protect downstream APIs from bursty traffic while preserving low latency for well-behaved clients. It exposes a lightweight gRPC and REST interface, backed by a sliding-window counter algorithm with sub-millisecond decision latency at the 99th percentile.

This document defines the functional requirements, the token accounting model, and a sketch of the public API surface for the initial release, codenamed **Merlin**.

> [!note]
> This specification describes the *control plane* only. Data-plane enforcement (e.g., sidecar proxies) is covered in a companion document, KES-002.

## 2. Goals and Non-Goals

### 2.1 Goals

- Provide per-tenant, per-route rate limiting with configurable windows.
- Support at least 50,000 decisions per second per node.
- Guarantee eventual consistency of counters across replicas within 250 ms.
- Expose a simple admission-control API: `Allow`, `Peek`, `Reset`.

### 2.2 Non-Goals

- Kestrel does not perform authentication or authorization.
- Kestrel does not persist historical traffic logs beyond 24 hours.

## 3. Requirements

The following checklist tracks implementation status for the Merlin milestone.

- [x] Define token-bucket and sliding-window hybrid algorithm
- [x] Implement in-memory counter store with LRU eviction
- [x] Draft gRPC service definitions
- [ ] Implement cross-region gossip replication
- [ ] Add persistent audit log export to object storage
- [ ] Complete load test at 100k RPS sustained for 1 hour
- [ ] Publish client SDKs for Go, Python, and Rust

## 4. Rate-Limiting Model

Kestrel uses a hybrid sliding-window counter. For a window of size $T$ seconds and a limit of $N$ requests, the estimated request count at time $t$ is computed by weighting the previous window's count by the fraction of overlap remaining.

Let $c_{\text{prev}}$ be the count in the previous window, $c_{\text{curr}}$ the count in the current window, and $\delta$ the elapsed time into the current window. The overlap weight $w$ is defined as $w = 1 - \delta / T$.

The estimated effective count $\hat{c}$ used for the admission decision is:

$$
\hat{c}(t) = c_{\text{curr}} + w \cdot c_{\text{prev}}, \qquad w = 1 - \frac{\delta}{T}
$$

A request is admitted if and only if $\hat{c}(t) + 1 \leq N$. This approximation bounds error to within $2\%$ of the true sliding-window count under uniform traffic, per internal simulation KES-SIM-14.

> [!warning]
> Under highly bursty, non-uniform traffic (coefficient of variation $> 3.0$), the hybrid estimator can undercount by up to 12%. Clients requiring strict enforcement should use the `strict_mode` flag, which falls back to a full log-based sliding window at higher memory cost.

## 5. Architecture Components

The system is organized into the following layers:

- Ingress layer
  - gRPC gateway
    - TLS termination
    - Request tagging (tenant ID, route ID)
      - Tag validation against schema registry
  - REST gateway (thin wrapper over gRPC)
- Decision engine
  - Counter store (sharded by tenant hash)
  - Estimator module (implements the $\hat{c}(t)$ formula above)
- Replication layer
  - Gossip protocol (SWIM-based)
  - Anti-entropy reconciliation job

As one engineer summarized during the design review:

> The hardest part of a rate limiter isn't limiting rates — it's agreeing, across five machines that don't trust each other's clocks, on what "now" even means.

## 6. API Sketch

### 6.1 Protocol Buffers Definition

```protobuf
syntax = "proto3";

package kestrel.v1;

service Throttle {
  rpc Allow (AllowRequest) returns (AllowResponse);
  rpc Peek (PeekRequest) returns (PeekResponse);
  rpc Reset (ResetRequest) returns (ResetResponse);
}

message AllowRequest {
  string tenant_id = 1;
  string route_id = 2;
  int32 cost = 3;        // default 1, allows weighted requests
  bool strict_mode = 4;
}

message AllowResponse {
  bool allowed = 1;
  int64 remaining = 2;
  double retry_after_ms = 3;
}

message PeekRequest {
  string tenant_id = 1;
  string route_id = 2;
}

message PeekResponse {
  int64 current_count = 1;
  int64 limit = 2;
  int64 window_seconds = 3;
}

message ResetRequest {
  string tenant_id = 1;
  string route_id = 2;
}

message ResetResponse {
  bool success = 1;
}
```

### 6.2 REST Equivalent

The REST gateway maps each RPC to a corresponding HTTP verb:

| RPC | HTTP Method | Path |
|-----|-------------|------|
| Allow | POST | `/v1/throttle/allow` |
| Peek | GET | `/v1/throttle/peek` |
| Reset | POST | `/v1/throttle/reset` |

A sample request/response pair for `Allow`:

```json
{
  "tenant_id": "acme-corp",
  "route_id": "checkout-api",
  "cost": 1,
  "strict_mode": false
}
```

```json
{
  "allowed": true,
  "remaining": 482,
  "retry_after_ms": 0
}
```

## 7. Performance Targets

| Metric | Target |
|--------|--------|
| p50 decision latency | < 0.4 ms |
| p99 decision latency | < 3.5 ms |
| Cross-node counter drift | < 5% |
| Availability | 99.95% monthly |

The theoretical minimum memory footprint per tenant-route pair is approximately $32$ bytes for counters plus $16$ bytes of metadata overhead, giving roughly $48N_r$ bytes total memory for $N_r$ active route entries per tenant.

## 8. Failure Modes

- **Split-brain replication**: If gossip partitions occur for longer than 30 seconds, nodes fall back to local-only enforcement with a conservative 20% limit reduction.
- **Clock skew**: Nodes with skew exceeding 500 ms are automatically quarantined from the gossip ring until NTP resynchronization completes.
- **Counter store exhaustion**: When LRU eviction pressure exceeds 90% capacity, the system emits a `kestrel_store_pressure` metric and begins proactively evicting entries with zero recent activity.

## 9. Open Questions

1. Should `strict_mode` be a per-request flag or a per-tenant configuration default?
2. How should Kestrel behave when the estimator and the strict log-based count disagree by more than a configurable threshold, e.g. $\epsilon = 0.1$?
3. Is a 24-hour retention window sufficient for downstream billing reconciliation, or should this be extended to 72 hours in a future revision (KES-003)?

## 10. Revision History

- v0.9 — Initial draft circulated for internal review.
- v0.8 — Added hybrid estimator formula and error bounds.
- v0.7 — Early architecture sketch, no API definitions.
