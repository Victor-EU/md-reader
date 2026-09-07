# Review Summary: "Adaptive Resonance Scheduling for Distributed Compute Clusters" (Draft v3.2)

## Overview

This review covers the internal whitepaper submitted by the Voreth Systems research group, authored by M. Kallendra and T. Osgrove. The document proposes a scheduling algorithm named **ARS-7** for distributed workload balancing across heterogeneous node clusters.

## Findings

1. The core throughput model is well-specified, but the derivation skips several intermediate steps.
2. Benchmark results (Section 5) use only 3 test clusters, which is insufficient for generalization claims.
3. The complexity analysis claims $O(n \log n)$ average-case performance, but the worst-case bound is never formally proven.
4. Notation is inconsistent — the load factor is written as both $\lambda$ and $L$ in different sections.

> [!warning]
> The claimed 42% latency reduction in Table 4 is not reproducible using the provided configuration file `cluster_config.yaml`. This should be flagged before publication.

## Core Equation Under Review

The authors present the amortized cost function as:

$$
C(n) = \sum_{i=1}^{n} \left( \frac{w_i}{\lambda_i} + \delta_i \right) \quad \text{where } \delta_i \ll \lambda_i
$$

The assumption $\delta_i \ll \lambda_i$ is not justified empirically anywhere in the paper.

## Sample Config Reviewed

```yaml
cluster:
  nodes: 12
  scheduler: ars7
  timeout_ms: 4500
  retries:
    - policy: exponential
    - max_attempts: 5
```

## Structural Nesting Example (Section Dependencies)

- Section 3: Algorithm Design
  - 3.1 Node Selection
    - 3.1.1 Weight Initialization
    - 3.1.2 Decay Function
  - 3.2 Failure Recovery
    - 3.2.1 Timeout Handling

## Recommended Changes

- [x] Clarify notation ($\lambda$ vs $L$) throughout Sections 2–4
- [x] Add derivation steps for the cost function
- [ ] Expand benchmark suite to at least 10 clusters
- [ ] Provide reproducible config and raw benchmark logs
- [ ] Add formal proof for worst-case complexity bound

## Questions for Authors

1. Why was the 3-cluster benchmark considered sufficient for publication-grade claims?
2. Can the authors justify $\delta_i \ll \lambda_i$ with real telemetry data?
3. Is ARS-7 expected to scale beyond 500 nodes, or is this out of scope?
