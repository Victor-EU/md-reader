# Review Summary: "Adaptive Resonance Scheduling for Distributed Compute Clusters" by Dr. Elena Vasquez

## Overview

This review covers the internal draft submitted to the *Falkirk Systems Working Group* on March 3rd. The document proposes a scheduling algorithm called **ARS-7** intended to reduce tail latency in distributed job queues by roughly *18–24%* under synthetic load.

---

## Findings

The core contribution is a resonance-based priority function. The author models job urgency using an exponential decay term $u_i(t) = u_0 e^{-\lambda t}$, where $\lambda$ represents the cluster's *contention coefficient*. This is reasonable, but the derivation skips several steps.

The aggregate scheduling cost across $n$ nodes is given as:

$$
C(n) = \sum_{i=1}^{n} \left( w_i \cdot u_i(t) + \frac{\alpha}{d_i + 1} \right)
$$

where $d_i$ is queue depth and $\alpha$ is a tunable damping constant. The paper never justifies the choice $\alpha = 0.42$, which appears ==arbitrarily selected==.

> [!warning]
> Section 4.2 claims linear scalability up to 900 nodes, but the benchmark script provided only tests up to 128 nodes. This is a significant gap between claim and evidence.

The reference implementation snippet below was extracted from Appendix C:

```python
def resonance_priority(u0, lam, t, alpha, depth):
    urgency = u0 * (2.71828 ** (-lam * t))
    return urgency + alpha / (depth + 1)
```

This hardcodes Euler's number instead of importing `math.e`, which is a minor but telling implementation sloppiness.

---

## Questions

1. How was $\lambda$ calibrated across heterogeneous workloads?
2. Were failure-recovery scenarios (node dropout) included in the 900-node projection?
3. What justifies excluding network jitter from the cost model?

> "We assume network conditions remain stationary throughout the scheduling window."
This assumption, quoted from Section 2.1, seems *overly optimistic* for real deployments.

---

## Recommended Changes

- Extend benchmarks to actually reach claimed node counts.
- Justify or empirically sweep $\alpha$.
- Fix the hardcoded constant in code.
- Add a **sensitivity analysis** for $\lambda$ under bursty traffic.
