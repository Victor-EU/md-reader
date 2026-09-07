# Technical Specification: Vesper Rate Limiting Gateway

**Version:** 0.9.3-draft
**Status:** *Under Review*
**Author:** Platform Infrastructure Group

## 1. Overview

Vesper is a lightweight, embeddable rate-limiting gateway designed to sit in front of internal microservices at **Northfield Systems**. It provides token-bucket based throttling, per-tenant quota enforcement, and adaptive backoff signaling for downstream clients. This document specifies the *functional requirements*, the *core algorithm*, and a sketch of the public API surface that consumers will integrate against.

The primary design goal is to keep the median request overhead under 0.4 ms while supporting at least 250,000 distinct rate-limit buckets per node without exhausting memory beyond a configured ceiling.

> A system that cannot explain why it rejected a request is not a rate limiter — it is a black box wearing a rate limiter's badge.

## 2. Goals and Non-Goals

### 2.1 Goals

- Provide deterministic, explainable throttling decisions.
- Support **per-tenant**, **per-route**, and **per-credential** bucket scoping.
- Emit ==structured telemetry== for every throttling decision.
- Allow hot-reloading of policy configuration without restarting the process.
- Guarantee that bucket state survives a graceful restart via snapshotting.

### 2.2 Non-Goals

- Vesper does *not* perform authentication or authorization — it assumes identity has already been resolved upstream.
- Vesper does *not* implement distributed consensus across nodes in v0.9; cross-node synchronization is deferred to v1.2.

## 3. Requirements

The following checklist tracks implementation status for the current milestone (M4):

- [x] Token bucket core algorithm implemented and unit-tested
- [x] Per-route configuration schema finalized
- [x] Snapshot persistence to local disk
- [ ] Cross-node gossip protocol for shared quota state
- [x] Structured JSON logging of throttle decisions
- [ ] Admin API for live policy inspection
- [x] Backpressure signaling via `Retry-After` headers
- [ ] Chaos testing harness for burst traffic simulation

> [!note]
> Items left unchecked are scheduled for milestone **M5**, targeted for the *Solstice* release train (approx. six weeks after M4 sign-off).

### 3.1 Functional Requirements

1. The system **must** reject requests exceeding the configured rate with an HTTP `429` status code.
2. The system **must** attach a `X-Vesper-Reason` header explaining the rejection cause.
3. The system **should** allow bursts up to a configurable multiple of the steady-state rate.
4. The system **may** expose a dry-run mode where limits are evaluated but never enforced, useful for tuning.

### 3.2 Non-Functional Requirements

- **Latency:** p99 decision latency must remain below 1.2 ms under 50,000 requests/sec per node.
- **Memory:** Bucket state must not exceed 180 bytes per tenant-route pair on average.
- **Durability:** Snapshot writes must complete within 250 ms for a state set of one million buckets.

## 4. Algorithm

Vesper uses a variant of the classic *token bucket* algorithm augmented with a decay-weighted burst allowance. Each bucket $b$ is characterized by a capacity $C_b$, a refill rate $r_b$ (tokens per second), and a current token count $n_b(t)$.

The token count at time $t$, given the last update at time $t_0$, is computed as:

$$
n_b(t) = \min\Big(C_b,\ n_b(t_0) + r_b \cdot (t - t_0)\Big)
$$

A request consuming $k$ tokens is admitted if and only if $n_b(t) \geq k$, after which the bucket is updated to $n_b(t) - k$. If $n_b(t) < k$, the request is rejected and the client receives a suggested retry delay of $\Delta = (k - n_b(t)) / r_b$ seconds.

For burst-tolerant routes, Vesper applies a secondary *decay window* $w$ such that the effective capacity temporarily rises to $C_b \cdot \beta$ where $\beta \in [1.0, 2.5]$ is the configured burst multiplier, decaying back to $C_b$ over the window $w$.

> [!warning]
> Setting $\beta$ above **2.0** for high-cardinality routes (more than 10,000 distinct buckets) can cause memory pressure spikes during traffic surges. Profile before deploying to production.

## 5. Configuration Model

Configuration is expressed as a nested YAML document. The hierarchy is at minimum three levels deep, reflecting the *tenant → route → policy* relationship:

- **tenants**
  - `tenant: northwind-labs`
    - **routes**
      - `route: /orders/create`
        - `capacity: 500`
        - `refill_rate: 50`
        - `burst_multiplier: 1.8`
      - `route: /orders/cancel`
        - `capacity: 200`
        - `refill_rate: 20`
    - **fallback_policy**
      - `capacity: 100`
      - `refill_rate: 10`
  - `tenant: acme-freight`
    - **routes**
      - `route: /shipments/track`
        - `capacity: 1000`
        - `refill_rate: 120`
        - **overrides**
          - `region: eu-west`
            - `capacity: 1400`
          - `region: ap-south`
            - `capacity: 800`

Each `overrides` block allows regional adjustment without duplicating the entire route definition, which keeps configuration files *concise* and *auditable*.

## 6. API Sketch

The gateway exposes a minimal control-plane API alongside the data-plane enforcement path. Below is a representative sketch of the core Rust trait and a sample HTTP handler binding.

```rust
/// Core trait implemented by all bucket backends.
pub trait RateLimiter {
    /// Attempts to consume `cost` tokens from the bucket identified
    /// by `key`. Returns a Decision describing the outcome.
    fn check(&self, key: &BucketKey, cost: u32) -> Decision;

    /// Forces a snapshot of current bucket state to durable storage.
    fn snapshot(&self) -> Result<SnapshotHandle, VesperError>;

    /// Reloads policy configuration from the given source without
    /// dropping in-flight bucket state.
    fn reload_policy(&self, source: PolicySource) -> Result<(), VesperError>;
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub allowed: bool,
    pub remaining_tokens: f64,
    pub retry_after_ms: Option<u64>,
    pub reason: DecisionReason,
}

#[derive(Debug, Clone)]
pub enum DecisionReason {
    Ok,
    CapacityExceeded,
    TenantSuspended,
    UnknownRoute,
}

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct BucketKey {
    pub tenant: String,
    pub route: String,
    pub region: Option<String>,
}
```

A typical HTTP integration wraps this trait in middleware:

```yaml
# gateway.middleware.yaml
middleware:
  - name: vesper-throttle
    module: vesper::http::TokenBucketMiddleware
    config:
      policy_file: /etc/vesper/policies.yaml
      snapshot_interval_seconds: 30
      dry_run: false
```

### 6.1 REST Endpoints (Control Plane)

| Method | Path                        | Description                                   |
|--------|-----------------------------|------------------------------------------------|
| GET    | `/v1/buckets/{tenant}`      | Returns current token state for all routes.    |
| POST   | `/v1/policies/reload`       | Triggers a hot reload of policy configuration. |
| GET    | `/v1/health`                | Liveness and readiness probe.                  |
| POST   | `/v1/snapshot`              | Forces an immediate snapshot write.            |

### 6.2 Response Headers

Every enforced request receives the following headers regardless of outcome:

- `X-Vesper-Remaining`: floating point token count remaining, e.g. `42.7`
- `X-Vesper-Capacity`: the bucket's configured capacity
- `X-Vesper-Reason`: one of `ok`, `capacity_exceeded`, `tenant_suspended`, `unknown_route`
- `Retry-After`: present only on `429` responses, expressed in seconds

## 7. Error Handling

Errors are surfaced through a unified `VesperError` enum. Consumers are expected to treat `VesperError::PolicyLoadFailure` as **fatal** during startup but **recoverable** during a hot reload — in the latter case, Vesper retains the previous known-good policy set and logs a structured warning.

> [!warning]
> A failed hot reload does *not* roll back partially-applied route overrides in versions prior to 0.9.2. Operators on older builds should restart the process after a failed reload to guarantee consistency.

## 8. Observability

Every decision emits a structured log line and an optional metrics event. The minimum required fields are:

1. `timestamp`
2. `tenant`
3. `route`
4. `decision` (allowed / rejected)
5. `remaining_tokens`
6. `latency_micros`

Metrics are exported in a Prometheus-compatible format, with the primary counter named `vesper_requests_total` and labeled by `tenant`, `route`, and `decision`.

## 9. Open Questions

- Should burst multipliers be allowed to vary *per region* independently of capacity overrides, or should they always inherit from the parent route?
- What is the acceptable staleness window for cross-node quota synchronization once M5 lands?
- Should dry-run mode emit synthetic `429` responses for testing harnesses, or only log what *would* have happened?

## 10. Appendix: Glossary

- **Bucket** — the unit of state tracking tokens for a specific tenant-route-region combination.
- **Decay window** — the time period over which burst capacity returns to baseline.
- **Dry-run mode** — an operational mode where decisions are computed but not enforced.
- **Snapshot** — a durable, point-in-time serialization of all bucket states.

This specification will be revised following the M4 retrospective, expected in the first week of the next planning cycle.
