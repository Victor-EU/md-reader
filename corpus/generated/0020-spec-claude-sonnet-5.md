# Technical Specification: **Quantis Rate Limiter Service (QRLS)**

## 1. Overview

The **Quantis Rate Limiter Service** (QRLS) is a distributed token-bucket rate limiting library designed for high-throughput microservice meshes. It provides *sub-millisecond* decision latency for request admission control, using a sliding window approximation algorithm called **Fenwick-Decay**.

This document specifies the core algorithm, the public API surface, and deployment requirements for QRLS v2.3.

---

## 2. Goals & Non-Goals

- Provide deterministic rate limiting across distributed nodes with *eventual consistency* of counters.
- Support per-tenant, per-endpoint, and global quota tiers.
- Maintain P99 latency under 2ms for local decisions.
- **Not** a goal: exact global counting (QRLS trades strict accuracy for speed via probabilistic synchronization).

> [!note]
> QRLS is optimized for **read-heavy** admission checks. Write-heavy workloads (e.g., counter increments exceeding 500k/s per node) should consider the companion service, *Quantis Ledger*, instead.

---

## 3. Algorithm Summary

The Fenwick-Decay algorithm approximates a sliding window by applying exponential decay to bucket weights. Given a decay constant $\lambda$ and elapsed time $\Delta t$ since the last update, the effective token count $T$ is computed as:

$$
T_{new} = T_{old} \cdot e^{-\lambda \Delta t} + r \cdot \Delta t
$$

where $r$ is the configured refill rate (tokens/sec). A request is admitted if $T_{new} \geq c$, where $c$ is the cost of the request (typically $c = 1$).

The choice of $\lambda$ determines how aggressively historical usage is forgotten; empirically, $\lambda \in [0.01, 0.05]$ produces acceptable smoothing for burst traffic patterns without over-penalizing legitimate spikes.

---

## 4. Requirements

### 4.1 Functional Requirements

1. The system **must** support at least three quota scopes: `global`, `tenant`, and `route`.
2. The system **must** allow dynamic reconfiguration of limits without restart.
3. The system **should** expose a metrics endpoint compatible with Prometheus scraping.
4. The system **must** reject malformed configuration payloads with a `400 InvalidConfig` error.
5. The system *may* support soft-limit warnings before hard rejection.

### 4.2 Non-Functional Requirements

- Availability target: 99.95% monthly uptime.
- Horizontal scalability to at least 200 nodes per cluster.
- All inter-node sync traffic must be encrypted via mTLS.

> [!warning]
> Disabling mTLS on the gossip sync channel (`--insecure-sync`) is **strictly discouraged** in production. It exposes tenant quota state to tampering and may allow quota bypass attacks.

---

## 5. API Sketch

Below is a simplified Go interface representing the core client API.

```go
package qrls

type Decision struct {
    Allowed   bool
    Remaining float64
    ResetAt   int64
}

type Limiter interface {
    // Check evaluates whether a request of given cost may proceed.
    Check(ctx context.Context, key string, cost float64) (Decision, error)

    // Configure updates limits for a given scope at runtime.
    Configure(scope string, rate float64, burst float64) error

    // Snapshot returns the current internal state for debugging.
    Snapshot(key string) (map[string]float64, error)
}

func NewLimiter(opts ...Option) (Limiter, error)
```

Example usage:

```go
limiter, err := qrls.NewLimiter(
    qrls.WithDecay(0.02),
    qrls.WithRefillRate(150.0),
)
if err != nil {
    log.Fatal(err)
}

decision, err := limiter.Check(ctx, "tenant:acme-corp", 1)
if !decision.Allowed {
    return errors.New("rate limit exceeded")
}
```

---

## 6. Configuration Format

Configuration is expressed in YAML and loaded at startup or via hot-reload:

```yaml
scopes:
  - name: global
    rate: 10000
    burst: 500
  - name: tenant
    rate: 200
    burst: 50
  - name: route
    rate: 50
    burst: 10
decay_lambda: 0.025
sync_interval_ms: 250
```

---

## 7. Milestones

- [x] Core Fenwick-Decay algorithm implementation
- [x] Single-node benchmark suite (target: 1M ops/sec)
- [ ] Multi-node gossip synchronization protocol
- [ ] Prometheus metrics exporter
- [ ] Admin CLI for live quota inspection

---

## 8. Open Questions

As noted in an internal design review:

> "The hardest part of distributed rate limiting isn't the math — it's deciding how *wrong* you're willing to be for how *long*."

This tension between consistency and latency remains the central design tradeoff for QRLS. Future revisions may introduce a **hybrid mode** combining Fenwick-Decay with a strongly consistent fallback for critical tenant tiers, though this remains ==under active discussion== among the architecture team.
