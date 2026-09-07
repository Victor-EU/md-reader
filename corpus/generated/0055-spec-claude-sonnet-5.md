# Technical Specification: Zephyrix Adaptive Rate Limiter (ZARL)

**Document ID:** ZARL-TS-0417
**Version:** 1.3.0
**Status:** Draft for Review
**Author:** Platform Infrastructure Group, Corvenna Systems

---

## 1. Overview

The Zephyrix Adaptive Rate Limiter (ZARL) is a distributed traffic-shaping component designed to protect downstream services in the Marrowbrook cluster from bursty client load. Unlike static token-bucket implementations, ZARL continuously recalibrates its throughput ceiling based on observed latency percentiles and error rates, using a feedback controller inspired by classical control theory.

This document describes the functional requirements, mathematical model, and public API surface for ZARL v1.3, targeted for integration into the Halcyon Gateway service mesh.

> [!note]
> This specification assumes familiarity with the Halcyon Gateway's plugin architecture, described separately in document HG-ARCH-0112. ZARL is implemented as a gateway-side filter, not a standalone proxy.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- Provide per-tenant, per-route rate limiting with sub-millisecond decision latency.
- Dynamically adjust limits in response to backend health signals.
- Support graceful degradation under controller misconfiguration (fail-open or fail-closed, configurable).
- Expose a minimal, stable API for embedding in the Halcyon filter chain.

### 2.2 Non-Goals

- ZARL does not perform authentication or authorization; it assumes requests arrive pre-validated.
- ZARL does not persist long-term traffic history beyond a rolling window of 15 minutes.
- ZARL is not intended to replace circuit breakers, though it may cooperate with one (see §6.3).

---

## 3. System Requirements

### 3.1 Functional Requirements

1. **FR-1**: The system MUST support configuration of rate limits at three granularities: global, per-tenant, and per-route.
2. **FR-2**: The system MUST recompute the effective rate limit at a configurable interval, default $ \Delta t = 500\text{ms} $.
3. **FR-3**: The system MUST expose current limiter state via a read-only introspection endpoint.
4. **FR-4**: The system MUST support at least two backpressure signals as controller inputs:
   - Observed p95 latency of downstream calls.
   - Observed error ratio (5xx responses over total responses) in the trailing window.
5. **FR-5**: The system MUST allow operators to define a hard floor and ceiling for the adaptive limit, preventing runaway oscillation.

### 3.2 Non-Functional Requirements

1. **NFR-1**: Decision latency (accept/reject) MUST NOT exceed $150\mu s$ at the 99th percentile under nominal load.
2. **NFR-2**: Memory overhead per tracked tenant MUST NOT exceed 4 KiB.
3. **NFR-3**: The controller state MUST be recoverable after a process restart within 2 seconds, using a snapshot mechanism.
4. **NFR-4**: The system MUST degrade predictably; see the failure mode taxonomy below:
   - Configuration failures
     - Missing tenant entry
       - Fallback to global default limit
       - Emit warning metric `zarl.config.tenant_missing`
     - Malformed floor/ceiling pair (floor > ceiling)
       - Reject configuration at load time
       - Retain previous valid configuration in memory
   - Runtime failures
     - Controller divergence (oscillation beyond threshold)
       - Freeze limit at last stable value
       - Emit alert `zarl.controller.diverged`
     - Snapshot corruption on restart
       - Fall back to conservative floor value
       - Log full snapshot payload for forensic review

> [!warning]
> Operators who set the floor value above the ceiling value in a shared configuration file will cause the entire route group to reject the configuration at load time. There is intentionally no automatic reconciliation of this condition, as silent correction has historically masked provisioning errors in the Thistlewood incident of Q3.

---

## 4. Control Model

ZARL's core adaptive mechanism is a discrete-time proportional-integral (PI) controller. The controller output at step $k$, denoted $L_k$ (the effective rate limit in requests per second), is computed as:

$$
L_k = \text{clamp}\left(L_{k-1} + K_p \cdot e_k + K_i \sum_{j=0}^{k} e_j \cdot \Delta t,\ L_{\text{floor}},\ L_{\text{ceiling}}\right)
$$

where the error term $e_k$ is a weighted combination of latency deviation and error-rate deviation:

$$
e_k = -w_1 \left(\frac{p95_k - p95_{\text{target}}}{p95_{\text{target}}}\right) - w_2 \left(\frac{\epsilon_k - \epsilon_{\text{target}}}{\epsilon_{\text{target}}}\right)
$$

Here $p95_k$ is the observed p95 latency at step $k$, $\epsilon_k$ is the observed error ratio, and $w_1, w_2$ are configurable weights satisfying $w_1 + w_2 = 1$. The default weights are $w_1 = 0.7$ and $w_2 = 0.3$.

The controller gains $K_p$ and $K_i$ default to $0.4$ and $0.05$ respectively, though tuning is expected per deployment. A well-tuned controller should exhibit a settling time under 8 seconds for a step disturbance of 25% in $p95_k$.

### 4.1 Stability Considerations

Operators should note that excessively large $K_i$ values can induce sustained oscillation. As a rough guideline, the product $K_i \cdot \Delta t$ should remain below $0.1$ for typical deployments with $\Delta t = 500\text{ms}$.

---

## 5. Data Model

### 5.1 Tenant Record

Each tracked tenant maintains the following fields:

| Field | Type | Description |
|---|---|---|
| `tenant_id` | string | Unique identifier, max 64 bytes |
| `current_limit` | float64 | Current effective rate limit (req/s) |
| `floor` | float64 | Configured minimum limit |
| `ceiling` | float64 | Configured maximum limit |
| `window_p95_ms` | float64 | Rolling p95 latency estimate |
| `window_error_ratio` | float64 | Rolling error ratio estimate |
| `last_updated_ns` | int64 | Monotonic timestamp of last recalculation |

### 5.2 Route Overlay

Routes may override tenant-level defaults using a sparse overlay structure. Only fields present in the overlay are applied; absent fields inherit from the tenant record.

---

## 6. API Sketch

The following interface is written in a Go-like pseudocode for illustration. Actual bindings will be generated for Go, Rust, and the Halcyon WASM plugin ABI.

```go
package zarl

// Limiter is the primary entry point embedded in the gateway filter chain.
type Limiter interface {
    // Decide returns whether the request should proceed, along with
    // a Decision containing diagnostic metadata.
    Decide(ctx RequestContext) (Decision, error)

    // Report feeds observed outcome data back into the controller.
    // Callers MUST invoke Report exactly once per request that
    // was previously admitted via Decide.
    Report(ctx RequestContext, outcome Outcome) error

    // Snapshot returns a serializable copy of internal state,
    // used for warm restarts.
    Snapshot() (StateSnapshot, error)

    // Restore loads a previously captured snapshot.
    Restore(snap StateSnapshot) error
}

// RequestContext carries the minimal routing information ZARL needs.
type RequestContext struct {
    TenantID  string
    RouteID   string
    Timestamp int64 // monotonic nanoseconds
}

// Decision is the result of a rate-limit check.
type Decision struct {
    Allowed      bool
    CurrentLimit float64
    Reason       string // e.g. "within_limit", "ceiling_reached"
}

// Outcome describes what happened to an admitted request.
type Outcome struct {
    LatencyMS  float64
    StatusCode int
}

// StateSnapshot is an opaque, versioned blob.
type StateSnapshot struct {
    Version int
    Payload []byte
}
```

### 6.1 Introspection Endpoint

A read-only HTTP endpoint, `GET /zarl/v1/state/{tenant_id}`, returns a JSON representation of the tenant record described in §5.1. This endpoint is intended for operator dashboards and MUST NOT be used as a hot-path dependency.

### 6.2 Configuration Format

Configuration is supplied as YAML, loaded at startup and hot-reloadable via a SIGHUP-triggered reload:

```yaml
tenants:
  - id: "orchard-analytics"
    floor: 50.0
    ceiling: 2000.0
    weights:
      latency: 0.7
      error_rate: 0.3
  - id: "bramblewood-ingest"
    floor: 10.0
    ceiling: 400.0
```

### 6.3 Cooperation with Circuit Breakers

When ZARL is deployed alongside a circuit breaker component (such as the Halcyon `cb-filter`), the breaker's open/half-open/closed state SHOULD be exposed to ZARL as an additional input signal. Implementations may treat an open breaker as equivalent to $\epsilon_k = 1.0$ for the duration of the open state, forcing the controller toward the floor value.

---

## 7. Metrics and Observability

ZARL emits the following metrics at each recalculation step:

- `zarl.limit.current` (gauge, per tenant)
- `zarl.error.rate` (gauge, per tenant)
- `zarl.latency.p95` (gauge, per tenant)
- `zarl.controller.error_term` (gauge, per tenant)
- `zarl.decisions.rejected_total` (counter, per tenant/route)

Operators are encouraged to alert on sustained proximity to either the floor or ceiling, as this typically indicates misconfigured bounds rather than genuine traffic conditions.

---

## 8. Open Questions

1. Should the controller support a derivative term ($K_d$) for faster response to sudden spikes, at the cost of increased sensitivity to measurement noise?
2. What is the appropriate default snapshot interval for NFR-3 compliance under high tenant cardinality (>10,000 tenants)?
3. Should route-level overlays be permitted to widen the floor/ceiling bounds beyond the tenant-level configuration, or only narrow them?

These questions are tracked in issue tracker project ZARL-OPEN and are expected to be resolved before the 1.4.0 release candidate.
