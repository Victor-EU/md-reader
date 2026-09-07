# Technical Specification: Vortex Rate Limiter Service

## Overview

Vortex is a distributed rate-limiting service designed to throttle API requests across a horizontally scaled fleet of edge nodes. It uses a token-bucket algorithm with adaptive refill rates based on observed traffic entropy.

---

## Requirements

1. The service must support at least 50,000 concurrent client buckets per node.
2. Latency for a single rate-check decision must not exceed 2 milliseconds at the 99th percentile.
3. Configuration changes must propagate to all nodes within 5 seconds.
4. The system must degrade gracefully when the coordination backend (Consensus Store) is unreachable, falling back to local-only enforcement.
5. All bucket state must be persisted asynchronously to avoid blocking the request path.

> [!note]
> Requirement 4 is considered the most critical resilience guarantee. Any implementation that blocks on the Consensus Store during an outage will fail acceptance testing.

> [!warning]
> Do not use wall-clock timestamps for bucket refill calculations without accounting for clock skew between nodes. Use the monotonic clock supplied by `vortex.clock.Monotonic`.

## Algorithm

Each bucket has a capacity $C$ and a refill rate $r$ tokens per second. Given an elapsed time $\Delta t$ since the last request, the available tokens $T$ are updated as:

$$
T_{new} = \min\left(C,\; T_{old} + r \cdot \Delta t\right)
$$

A request of cost $k$ is admitted only if $T_{new} \geq k$, after which:

$$
T_{final} = T_{new} - k
$$

The adaptive component adjusts $r$ periodically based on a smoothed entropy measure $H$ of recent request intervals, where $r_{next} = r \cdot (1 + \alpha (H - H_{target}))$ and $\alpha$ is a damping coefficient typically set near $0.05$.

## API Sketch

```python
class RateLimiter:
    def __init__(self, capacity: int, refill_rate: float, clock: Clock):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.clock = clock
        self.tokens = capacity
        self.last_check = clock.now()

    def allow(self, cost: int = 1) -> bool:
        now = self.clock.now()
        elapsed = now - self.last_check
        self.tokens = min(
            self.capacity,
            self.tokens + self.refill_rate * elapsed
        )
        self.last_check = now

        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
```

Client integrations should wrap this in a decorator or middleware layer, depending on the host framework.

---

## Implementation Checklist

- [x] Core token-bucket logic implemented
- [x] Monotonic clock abstraction added
- [x] Local fallback mode for Consensus Store outages
- [ ] Adaptive refill rate tuning module
- [ ] Cross-region bucket synchronization
- [ ] Load testing at 500k requests/sec sustained

## Operational Notes

> "A rate limiter that never triggers under normal load is not idle—it is untested." This principle guides our synthetic load generation strategy, which deliberately spikes traffic to 3x baseline during nightly canary runs.

Deployment teams should consult the runbook before enabling adaptive mode in production, as misconfigured damping coefficients have historically caused oscillating throughput in staging environments.
