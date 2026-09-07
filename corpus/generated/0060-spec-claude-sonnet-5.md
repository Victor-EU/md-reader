# Technical Specification: Vortex Rate Limiter

## Overview

Vortex is a distributed rate-limiting service designed to throttle API requests using a token-bucket algorithm with adaptive backoff. It targets throughput of $10^5$ requests per second per node.

## Requirements

- Support configurable time windows per client key
- Enforce burst limits independent of sustained rate
- Persist bucket state in a replicated key-value store
- Expose Prometheus-compatible metrics
- Provide gRPC and REST interfaces

### Task List

- [x] Define token-bucket data model
- [x] Implement core rate-limit algorithm
- [ ] Add multi-region replication support
- [ ] Write load-testing harness
- [ ] Publish client SDKs for Go and Python

---

## Algorithm

The core refill logic computes available tokens $T$ at time $t$ using the last refill timestamp $t_0$ and refill rate $r$:

$$
T(t) = \min\left(B_{max},\; T(t_0) + r \cdot (t - t_0)\right)
$$

where $B_{max}$ is the bucket capacity. A request of cost $c$ is accepted when $T(t) \geq c$.

> [!note]
> The refill rate $r$ is expressed in tokens per millisecond to avoid floating-point drift over long-running buckets.

> [!warning]
> Clock skew between nodes greater than 50ms may cause inconsistent throttling decisions. Deploy NTP synchronization before production rollout.

## API Sketch

```go
type Limiter interface {
    Allow(ctx context.Context, key string, cost int) (bool, error)
    Reset(ctx context.Context, key string) error
    Stats(ctx context.Context, key string) (BucketStats, error)
}

type BucketStats struct {
    Available float64
    Capacity  float64
    LastRefill int64
}
```

> As noted during the Q3 design review: "throttling decisions must be observable, not just enforceable."

## Deployment Notes

Nodes should be deployed behind a consistent-hashing load balancer, with each shard owning a disjoint key range.
