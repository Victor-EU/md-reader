# Project Helios: Weekly Status Report

**Date:** March 14, 2025
**Project Lead:** Priya Nakamura
**Team:** Distributed Systems Group, Cascade Labs

---

## Executive Summary

Project Helios—our initiative to build a low-latency inference pipeline for real-time anomaly detection—has completed Sprint 14. The team successfully migrated the core scoring engine from a monolithic architecture to a microservice-based design, resulting in significant throughput gains. This report summarizes progress, current metrics, blockers, and planned work for the upcoming sprint.

## Key Metrics

| Metric | Last Sprint | This Sprint | Target |
|---|---|---|---|
| p50 latency (ms) | 84 | 61 | 50 |
| p99 latency (ms) | 310 | 198 | 150 |
| Throughput (req/s) | 4,200 | 6,850 | 8,000 |
| Error rate (%) | 1.8 | 0.6 | 0.2 |
| Test coverage (%) | 71 | 79 | 85 |

Our latency reduction stems primarily from batching optimizations in the feature-extraction service. The relationship between batch size $b$ and average processing latency $\ell(b)$ has been empirically modeled as:

$$
\ell(b) = \alpha \cdot \log(b) + \frac{\beta}{b} + \gamma
$$

where $\alpha = 4.2$, $\beta = 112.5$, and $\gamma = 9.8$ based on our regression fit over the last 30 days of telemetry. This model suggests an optimal batch size $b^* \approx 27$, which aligns closely with the value of 32 currently configured in production.

## Architecture Update

The scoring engine now consists of three decoupled services: `ingest`, `scorer`, and `notifier`. Communication between them uses a message broker (Kafka-compatible) with at-least-once delivery semantics. Below is a simplified configuration snippet used in staging:

```yaml
services:
  scorer:
    replicas: 6
    resources:
      cpu: "2"
      memory: "4Gi"
    env:
      MODEL_VERSION: "v3.2.1"
      BATCH_SIZE: "32"
      TIMEOUT_MS: "250"
  notifier:
    replicas: 3
    resources:
      cpu: "1"
      memory: "2Gi"
    env:
      RETRY_LIMIT: "5"
      BACKOFF_STRATEGY: "exponential"
```

This configuration has been stable in staging for nine consecutive days without a restart, which we consider a strong signal for promotion to production.

> [!note]
> The `scorer` service's memory footprint increased by roughly 18% after the model upgrade to v3.2.1. This is expected due to the larger embedding table, but should be monitored closely during the canary rollout.

## Model Performance

The updated anomaly-scoring model (v3.2.1) shows improved precision on the validation set. Precision $p$ and recall $r$ are computed per class $i$, and the aggregate F1 score is given by the standard harmonic mean:

$F1 = 2 \cdot \dfrac{p \cdot r}{p + r}$

Current aggregate F1 stands at 0.912, up from 0.887 in the previous release. False positive rate on the "network-jitter" class remains our weakest area at 4.3%, and is the subject of ongoing investigation by the modeling subteam.

> [!warning]
> A regression was discovered in the `notifier` service where duplicate alerts were sent for approximately 0.4% of flagged events during a load test on March 11. Root cause appears related to idempotency key collisions under high concurrency. This must be resolved before the production rollout scheduled for March 21.

## Incidents and Risks

1. **Duplicate alert bug (High priority):** As noted above, idempotency keys are colliding under load exceeding 5,000 req/s. A fix involving UUID-based keys with a Redis-backed deduplication cache is in progress.
2. **Kafka consumer lag (Medium priority):** During peak traffic simulations, consumer lag on the `ingest` topic reached 12 seconds. We are evaluating partition rebalancing and increasing consumer replica count from 4 to 6.
3. **Dependency drift (Low priority):** Several internal libraries are now two minor versions behind the shared platform baseline. This is tracked but not currently blocking any milestones.
4. **On-call fatigue (Low priority):** Two engineers flagged increased on-call burden due to noisy alerting. This ties directly into the duplicate-alert bug and should improve once resolved.

## Budget and Timeline

The project remains within budget, having consumed approximately 62% of the allocated compute credits for Q1, against a 65% time-elapsed benchmark. No schedule slippage is currently projected, assuming the notifier bug is resolved within the next five business days.

---

## Next Steps

1. Ship the idempotency-key fix for the `notifier` service and validate under a repeat load test at 6,000 req/s.
2. Increase Kafka consumer replicas for the `ingest` topic and re-measure consumer lag under simulated peak load.
3. Continue investigation into the "network-jitter" false positive rate, targeting a reduction to below 3% by end of next sprint.
4. Raise test coverage from 79% to at least 85%, focusing on the `scorer` service's edge-case handling.
5. Prepare rollout plan and canary configuration for production deployment of model v3.2.1, contingent on resolution of the notifier regression.

## Closing Notes

Overall, Project Helios is trending positively, with meaningful latency and throughput improvements this sprint. The primary blocker to production promotion is the duplicate-alert issue in the `notifier` service, which the team is treating as top priority. Barring unforeseen complications, we anticipate a production deployment window opening by March 24.
