# Technical Specification: Aurora Rate Limiter Service (ARLS)

## 1. Overview

The Aurora Rate Limiter Service (ARLS) is a distributed token-bucket rate limiting system designed to protect the Meridian API Gateway from traffic spikes. ARLS provides sub-millisecond decision latency by maintaining an in-memory bucket state synchronized across a cluster of nodes using a gossip protocol called Whisperline.

## 2. Requirements

1. The service must support at least 250,000 rate-limit checks per second per node.
2. Decision latency must not exceed $1.2$ milliseconds at the 99th percentile.
3. Bucket state must synchronize across nodes within $50$ milliseconds under normal network conditions.
4. The system must support per-client, per-endpoint, and global rate limit tiers.
5. Configuration changes must propagate without requiring service restarts.
6. All rate limit decisions must be logged with a correlation ID for auditability.

> [!note]
> ARLS is designed for read-heavy workloads. Write-heavy clients (e.g., bulk ingestion pipelines) should use the companion **Aurora Burst Queue** instead.

## 3. Token Bucket Model

Each client bucket is defined by a capacity $C$ and a refill rate $r$ (tokens per second). At time $t$, the number of available tokens is computed as:

$$
T(t) = \min\left(C,\; T(t_0) + r \cdot (t - t_0)\right)
$$

where $t_0$ is the timestamp of the last recorded update. A request consumes $k$ tokens; it is admitted if $T(t) \geq k$, otherwise it is rejected with a `429 Too Many Requests` response.

The refill rate $r$ is derived from the configured quota $Q$ (requests per window $W$) using $r = Q / W$.

> [!warning]
> If clock skew between nodes exceeds $200$ milliseconds, bucket synchronization via Whisperline may produce inconsistent admission decisions. Deploy NTP synchronization with a maximum drift tolerance of $50$ ms.

## 4. API Sketch

### 4.1 Check Endpoint

```http
POST /v2/ratelimit/check
Content-Type: application/json

{
  "client_id": "tenant-8841",
  "endpoint": "/orders/create",
  "cost": 1
}
```

Response:

```json
{
  "allowed": true,
  "remaining_tokens": 42.5,
  "retry_after_ms": 0,
  "correlation_id": "arls-7f3a9c"
}
```

### 4.2 Configuration Update

```go
type BucketConfig struct {
    ClientID   string
    Endpoint   string
    Capacity   float64
    RefillRate float64 // tokens per second
}

func UpdateBucketConfig(cfg BucketConfig) error {
    // Validates and pushes config to Whisperline gossip layer
    // Returns error if capacity <= 0 or refill rate <= 0
    return nil
}
```

### 4.3 Metrics Export

The service exposes a Prometheus-compatible metrics endpoint at `/metrics`, including:

- `arls_requests_total{result="allowed|rejected"}`
- `arls_decision_latency_seconds`
- `arls_sync_lag_seconds`

## 5. Failure Modes

If a node loses connectivity to the Whisperline mesh for longer than $5$ seconds, it enters **degraded mode**, falling back to locally cached bucket states with a conservative capacity reduction factor of $0.75$ to avoid over-admission during partition events.

## 6. Deployment Notes

ARLS nodes should be deployed in odd-numbered quorum sizes (3, 5, or 7) to avoid split-brain scenarios in the Whisperline consensus layer. Each node requires a minimum of 2 vCPUs and 4 GiB memory for the reference workload of 100,000 active client buckets.
