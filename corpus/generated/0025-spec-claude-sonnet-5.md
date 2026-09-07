# Technical Specification: Vortex Rate Limiter v2.3

## 1. Overview

**Vortex** is a distributed rate-limiting service designed to throttle API requests across a fleet of *stateless* edge nodes. This document defines the requirements, algorithmic model, and public API for the Vortex Core Library, developed internally by the Quillhaven Systems team.

The system replaces the legacy *Sentinel Throttle* module, which suffered from clock-drift inconsistencies across regions.

> [!note]
> This specification targets Vortex Core v2.3 and is **not** backward compatible with v1.x token formats.

## 2. Goals and Non-Goals

### 2.1 Goals
- Provide ==sub-millisecond== decision latency for rate-limit checks.
- Support both **fixed-window** and *sliding-log* strategies.
- Guarantee eventual consistency across nodes within 250 ms.

### 2.2 Non-Goals
- Vortex does **not** provide request queuing or retry scheduling.
- Persistent long-term analytics storage is out of scope; that responsibility belongs to the downstream `Harborlight` metrics pipeline.

## 3. Algorithmic Model

Vortex uses a decayed token-bucket model. For a client $c$ with bucket capacity $B_c$ and refill rate $r_c$ (tokens per second), the number of available tokens at time $t$ is given by:

$$
T_c(t) = \min\left(B_c,\; T_c(t_0) + r_c \cdot (t - t_0)\right)
$$

where $t_0$ is the timestamp of the last recorded update. A request consuming $k$ tokens is admitted if and only if $T_c(t) \geq k$, after which the bucket is decremented by $k$.

The *effective* burst tolerance $\beta$ is derived from the ratio $\beta = B_c / r_c$, representing the maximum sustained burst duration in seconds.

> [!warning]
> If $r_c = 0$, the bucket becomes a hard cap with no replenishment. Clients must never configure a zero refill rate for production traffic — doing so will silently freeze all future requests once $B_c$ is exhausted.

## 4. Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | The system **must** support per-client bucket configuration via a control-plane API. | High |
| FR-2 | The system **must** replicate bucket state across at least 3 replica nodes. | High |
| FR-3 | The system *should* support a "soft-limit" mode that logs but does not reject requests. | Medium |
| FR-4 | The system **must** expose Prometheus-compatible metrics on port `9412`. | High |
| FR-5 | The system *may* support custom cost functions where $k$ varies by request type. | Low |

## 5. Non-Functional Requirements

- **Latency**: p99 decision time under 1.2 ms at 50,000 requests/sec per node.
- **Availability**: 99.95% uptime per region, measured monthly.
- **Durability**: Bucket state snapshots persisted every 30 seconds to the `Cinderlog` write-ahead store.

## 6. API Sketch

The core library is implemented in Rust, with bindings exposed via a lightweight gRPC gateway.

```rust
/// Represents a single rate-limit decision request.
pub struct LimitRequest {
    pub client_id: String,
    pub cost: u32,
    pub timestamp_ms: u64,
}

/// Result of evaluating a LimitRequest against a bucket.
pub struct LimitDecision {
    pub allowed: bool,
    pub remaining_tokens: f64,
    pub retry_after_ms: Option<u64>,
}

pub trait RateLimiter {
    /// Evaluates whether the given request should be admitted.
    fn check(&self, req: &LimitRequest) -> LimitDecision;

    /// Registers or updates bucket configuration for a client.
    fn configure(&mut self, client_id: &str, capacity: f64, refill_rate: f64);

    /// Removes a client's bucket entirely, freeing associated memory.
    fn evict(&mut self, client_id: &str);
}
```

### 6.1 Configuration Endpoint

```json
POST /v2/buckets/configure
{
  "client_id": "partner-arclight-04",
  "capacity": 500,
  "refill_rate": 12.5,
  "mode": "soft-limit"
}
```

### 6.2 Decision Endpoint

A typical decision response resembles:

```json
{
  "allowed": true,
  "remaining_tokens": 483.2,
  "retry_after_ms": null
}
```

## 7. Error Handling

All errors follow the `VortexError` enum, with variants such as `BucketNotFound`, `ReplicationTimeout`, and `InvalidCostFunction`. Clients **must** treat `ReplicationTimeout` as a transient condition and retry with exponential backoff.

## 8. Security Considerations

Access to the configuration endpoint requires a signed JWT issued by the `Quillhaven Auth Broker`. Tokens **must** be rotated every 24 hours. Requests lacking a valid signature *must* be rejected with HTTP 401, regardless of payload contents.

## 9. Rollout Plan

1. **Phase 1** — Shadow deployment alongside Sentinel Throttle, comparing decisions without enforcement.
2. **Phase 2** — Canary rollout to 5% of traffic in the `eu-west-3` region.
3. **Phase 3** — Full production cutover, with Sentinel Throttle decommissioned 60 days later.

> [!note]
> Rollback procedures are documented separately in the *Vortex Operations Runbook*, section 4.2.

## 10. Open Questions

- Should burst tolerance $\beta$ be configurable per request type rather than per client?
- Is a 250 ms consistency window acceptable for financial-tier clients, or does it require tightening to under 100 ms?
