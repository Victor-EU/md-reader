# Technical Specification: Vortex Rate Limiter Module

## Overview

The **Vortex Rate Limiter** (VRL) is a lightweight middleware component designed to throttle API requests using a sliding-window algorithm. It is intended for integration into the *Halcyon Gateway* microservice framework.

## Requirements

- The module **must** support configurable request windows, defined in milliseconds.
- The module *should* expose metrics via a `/stats` endpoint for observability.
- Rate limits must be enforced per client token, identified by a hashed API key.
- The system must degrade gracefully under Redis unavailability, falling back to an in-memory store.
- Configuration values must be ==validated at startup== to prevent silent misconfiguration.

### Nested Configuration Structure

- **Global Settings**
  - Window size
    - Default: 1000ms
    - Minimum: 100ms
      - Values below this throw a `ConfigError`
  - Burst allowance
    - Default: 20 requests
    - Maximum: 500 requests
- **Per-Client Overrides**
  - Token-based limits
  - IP-based fallback limits

> [!note]
> Burst allowance and window size interact multiplicatively — always test overrides against production-like traffic before deployment.

> [!warning]
> Disabling the Redis fallback in single-instance mode will cause request counters to reset on every restart, potentially allowing abuse.

## Algorithm

The request admission probability is computed using an exponential decay function:

$$
P(t) = 1 - e^{-\lambda t}, \quad \lambda = \frac{1}{\tau}
$$

where $\tau$ represents the configured window size and $\lambda$ is the decay constant derived from it.

## API Sketch

```typescript
interface VortexLimiter {
  checkLimit(token: string): Promise<boolean>;
  getStats(token: string): Promise<UsageStats>;
  configure(options: VortexConfig): void;
}

interface VortexConfig {
  windowMs: number;
  burstAllowance: number;
  fallbackStore: "memory" | "redis";
}
```

---

Future revisions may introduce adaptive throttling based on server load, using a feedback loop similar to TCP congestion control.
