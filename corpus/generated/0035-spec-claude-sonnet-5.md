# Technical Specification: Corvid Rate-Limiting Gateway (CRG-7)

## 1. Overview

The Corvid Rate-Limiting Gateway (CRG-7) is a lightweight middleware service designed to sit between client applications and the Halcyon API cluster. Its purpose is to enforce adaptive rate limits, provide burst tolerance, and expose telemetry for capacity planning. This document describes the functional requirements, the token-bucket algorithm used for throttling, and a sketch of the public API surface.

CRG-7 replaces the legacy Sparrowhawk limiter, which suffered from coarse-grained window resets and poor tail-latency behavior under bursty traffic. The new design targets sub-millisecond decision latency at the 99th percentile while supporting per-tenant configuration.

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. Provide per-tenant, per-endpoint rate limiting with configurable refill rates.
2. Support graceful degradation when the backing store (Redshank cache) is unavailable.
3. Expose a metrics endpoint compatible with the Ptarmigan monitoring stack.
4. Allow dynamic reconfiguration of limits without service restart.
5. Maintain decision latency below 2 ms at p99 under a load of 50,000 requests/second.

### 2.2 Non-Goals

- CRG-7 does not perform authentication or authorization; that is delegated to the Osprey identity service.
- CRG-7 does not provide request routing or load balancing.
- Long-term storage of raw request logs is out of scope; only aggregated counters are retained.

---

## 3. Algorithmic Foundation

CRG-7 uses a token-bucket algorithm with continuous refill. Each tenant/endpoint pair is assigned a bucket with capacity $C$ and refill rate $r$ tokens per second. At time $t$, the number of available tokens $T(t)$ is bounded by:

$$
T(t) = \min\left(C,\; T(t_0) + r \cdot (t - t_0)\right)
$$

where $t_0$ is the timestamp of the last observed request for that bucket.

A request consumes $k$ tokens (typically $k = 1$, but weighted endpoints may set $k > 1$). The request is admitted if $T(t) \geq k$, in which case the bucket is updated as $T(t) \gets T(t) - k$. Otherwise the request is rejected with a `429` status and a `Retry-After` header computed as $\lceil (k - T(t)) / r \rceil$ seconds.

For burst smoothing, we additionally track a decaying average request rate $\bar{\lambda}$ using an exponential moving average with smoothing factor $\alpha = 0.2$:

$$\bar{\lambda}_{n} = \alpha \cdot \lambda_n + (1 - \alpha) \cdot \bar{\lambda}_{n-1}$$

This average is exposed via telemetry but does not directly gate admission decisions in the default configuration; it is used by the adaptive tuning subsystem described in Section 6.

> [!note]
> The refill rate $r$ and capacity $C$ are independently configurable per tenant tier. Default tiers (Bronze, Silver, Gold) ship with preset values documented in Appendix A of the operator handbook (not included in this spec).

---

## 4. System Requirements

### 4.1 Functional Requirements

1. The gateway MUST evaluate every inbound request against the appropriate token bucket before forwarding to the Halcyon API cluster.
2. The gateway MUST support at least three levels of limit granularity:
   - Global limits
     - Per-region limits
       - Per-tenant limits
         - Per-endpoint limits within a tenant
   - Custom override limits
     - Temporary overrides (time-boxed)
       - Manual overrides (operator-issued)
       - Automated overrides (issued by the adaptive tuner)
     - Permanent overrides (contractual)
3. The gateway MUST persist bucket state in the Redshank cache with a TTL no shorter than 300 seconds.
4. The gateway MUST fail open (allow requests) if the Redshank cache is unreachable for more than 500 ms, subject to a configurable local fallback limiter.
5. The gateway MUST expose a `/healthz` endpoint returning `200 OK` when the internal event loop lag is below 50 ms.
6. The gateway MUST log rejected requests with tenant ID, endpoint, and computed `Retry-After` value.

### 4.2 Non-Functional Requirements

1. Availability: 99.95% monthly uptime, excluding scheduled maintenance windows.
2. Latency: p50 ≤ 0.4 ms, p99 ≤ 2 ms, p99.9 ≤ 8 ms for admission decisions.
3. Throughput: sustain 50,000 requests/second per gateway instance on reference hardware (8 vCPU, 16 GiB RAM).
4. Observability: all configuration changes MUST be recorded in the audit log with an immutable sequence number.

> [!warning]
> Disabling the fail-open fallback (Requirement 4.1.4) in production without a redundant Redshank cluster will cause total request rejection during any cache outage. Operators must provision at least two independent Redshank replicas before disabling fail-open behavior.

---

## 5. Configuration Model

Configuration is expressed as YAML and loaded at startup, with hot-reload support via a `SIGHUP` signal or the `/admin/reload` endpoint.

```yaml
tenant: acme-corp
tier: gold
limits:
  default:
    capacity: 500
    refill_rate: 100
  endpoints:
    - path: /v2/orders
      capacity: 200
      refill_rate: 40
      weight: 1
    - path: /v2/orders/bulk
      capacity: 50
      refill_rate: 5
      weight: 10
overrides:
  - id: ov-20391
    type: temporary
    expires_at: "2025-03-01T00:00:00Z"
    capacity: 1000
    refill_rate: 250
    reason: "Q1 promotional traffic surge"
fallback:
  fail_open: true
  local_capacity: 20
  local_refill_rate: 5
```

Configuration validation occurs before activation. Invalid configurations are rejected and the previous valid configuration remains active, with an error surfaced on `/admin/status`.

---

## 6. Adaptive Tuning Subsystem

The adaptive tuner monitors $\bar{\lambda}$ per bucket and adjusts temporary overrides when sustained demand exceeds 85% of capacity for more than 120 consecutive seconds. The adjustment procedure is:

1. Compute the utilization ratio $u = \bar{\lambda} / r$.
2. If $u > 0.85$ for the trailing 120-second window, propose a new refill rate $r' = r \cdot 1.15$, capped at a tenant-specific maximum ceiling.
3. Submit the proposal to the override queue.
4. Apply the proposal automatically if the tenant tier permits automated overrides; otherwise, queue for manual operator approval.
5. Re-evaluate utilization every 60 seconds and decay the override back toward baseline over a 30-minute window once utilization drops below 0.5.

This subsystem is optional and disabled by default for Bronze-tier tenants.

---

## 7. API Sketch

The following is a sketch of the primary HTTP API surface exposed by CRG-7. All endpoints are versioned under `/v1`.

### 7.1 Admission Check (internal, used by the proxy layer)

```
POST /v1/internal/admit
Content-Type: application/json

{
  "tenant_id": "acme-corp",
  "endpoint": "/v2/orders",
  "cost": 1,
  "timestamp": 1732458213.221
}
```

Response on success:

```
200 OK
{
  "allowed": true,
  "remaining_tokens": 187.4,
  "reset_after_seconds": 3.2
}
```

Response on rejection:

```
429 Too Many Requests
Retry-After: 4
{
  "allowed": false,
  "remaining_tokens": 0.0,
  "reset_after_seconds": 4.0,
  "reason": "capacity_exceeded"
}
```

### 7.2 Configuration Management

```
GET    /v1/admin/tenants/{tenant_id}/limits
PUT    /v1/admin/tenants/{tenant_id}/limits
POST   /v1/admin/tenants/{tenant_id}/overrides
DELETE /v1/admin/tenants/{tenant_id}/overrides/{override_id}
```

Example payload for creating an override:

```json
{
  "type": "temporary",
  "expires_at": "2025-04-15T12:00:00Z",
  "capacity": 750,
  "refill_rate": 150,
  "reason": "Scheduled load test with QA team"
}
```

### 7.3 Telemetry

```
GET /v1/metrics
```

Returns Ptarmigan-compatible plaintext exposition format, including at minimum:

- `crg_admit_total{tenant, endpoint, result}`
- `crg_tokens_remaining{tenant, endpoint}`
- `crg_decision_latency_seconds_bucket{le}`
- `crg_fallback_activations_total{tenant}`

### 7.4 Health and Status

```
GET /healthz
GET /v1/admin/status
```

`/v1/admin/status` returns the currently active configuration version, the timestamp of the last successful reload, and a list of pending override proposals awaiting manual approval.

---

## 8. Deployment Topology

CRG-7 is deployed as a stateless service fronted by the Kestrel load balancer, with each instance connecting independently to a shared Redshank cache cluster. Recommended minimum topology:

1. Three CRG-7 instances per region, distributed across separate availability zones.
2. A Redshank cluster of at least three nodes with quorum-based replication.
3. A dedicated audit-log sink (the Fieldfare log aggregator) for compliance retention of configuration changes, retained for a minimum of 400 days.

Instances register with Kestrel using a weighted round-robin scheme, with weights adjusted downward automatically if an instance's `/healthz` reports degraded status for three consecutive probe intervals.

---

## 9. Security Considerations

- All administrative endpoints under `/v1/admin` require mutual TLS and a signed operator token issued by Osprey.
- Override creation requests must include a `reason` field of at least 10 characters; empty or placeholder reasons (e.g., "test") are rejected by policy linting.
- Audit log entries are append-only and cryptographically chained using a running SHA-256 digest of the previous entry, so tampering with historical entries is detectable.

---

## 10. Open Questions

1. Should per-endpoint weights be allowed to exceed the bucket capacity itself, effectively guaranteeing rejection for that endpoint under any load?
2. What is the appropriate default ceiling multiplier for the adaptive tuner across tiers other than Gold?
3. Should the fail-open local fallback limiter share state across instances via a lightweight gossip protocol, or remain strictly per-instance?

These questions are tracked in the CRG-7 design backlog and are expected to be resolved before the 1.0 release candidate.
