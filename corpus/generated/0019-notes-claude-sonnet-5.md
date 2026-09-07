# Research Notes: Comparing Approaches to Streaming Change-Point Detection

## Context and Motivation

Detecting change-points in streaming numerical data — the moments where the underlying generative distribution shifts — is a recurring problem in monitoring systems, sensor networks, and financial telemetry pipelines. This note compares three candidate approaches evaluated internally on a synthetic benchmark suite (codenamed *Project Halcyon*) between March and June of an internal test cycle. The goal is to summarize tradeoffs in latency, statistical robustness, and implementation complexity.

The three approaches under consideration are:

1. **CUSUM-Adaptive (CA)** — a cumulative sum control chart with an adaptively tuned drift parameter.
2. **Bayesian Online Change-Point Detection (BOCD-lite)** — a simplified hazard-rate Bayesian recursion.
3. **Sliding-Window Kernel Divergence (SWKD)** — a two-window kernel-based distributional distance test.

---

## 1. CUSUM-Adaptive (CA)

The classical CUSUM statistic accumulates a running sum of deviations from an expected mean $\mu_0$, flagging a change when the accumulated statistic $S_t$ exceeds a threshold $h$. In the adaptive variant we tested, the drift parameter $k$ is updated using a decaying moving estimate of local variance rather than fixed a priori.

The core recursion used is:

$$
S_t = \max\left(0,\; S_{t-1} + (x_t - \mu_0 - k_t)\right), \qquad k_t = \alpha \hat{\sigma}_{t-1} + (1-\alpha) k_{t-1}
$$

where $\hat{\sigma}_{t-1}$ is an exponentially weighted standard deviation estimate and $\alpha \in (0,1)$ controls adaptation speed.

Empirically, CA performed well on data with a single dominant noise regime but struggled once heteroskedastic bursts were introduced. On the synthetic benchmark "Halcyon-3", detection latency averaged 14.2 samples with a false-alarm rate of roughly 0.6%.

> [!note]
> CA is extremely cheap computationally — $O(1)$ per sample — which made it the default choice for embedded deployments with tight power budgets.

A minimal reference implementation:

```python
def cusum_adaptive(x, mu0, alpha=0.05, h=5.0):
    S = 0.0
    k = 0.1
    sigma_hat = 1.0
    alarms = []
    for t, xt in enumerate(x):
        sigma_hat = alpha * abs(xt - mu0) + (1 - alpha) * sigma_hat
        k = alpha * sigma_hat + (1 - alpha) * k
        S = max(0.0, S + (xt - mu0 - k))
        if S > h:
            alarms.append(t)
            S = 0.0
    return alarms
```

---

## 2. Bayesian Online Change-Point Detection (BOCD-lite)

BOCD-lite maintains a posterior distribution over the "run length" $r_t$ — the number of samples since the last change-point. At each step, the algorithm computes a predictive probability $\pi_t = p(x_t \mid r_{t-1})$ under a simple Gaussian conjugate model and updates the run-length distribution using a fixed hazard rate $H$.

The update follows the standard message-passing form:

$$
p(r_t \mid x_{1:t}) \propto \sum_{r_{t-1}} p(x_t \mid r_{t-1}) \, p(r_t \mid r_{t-1}) \, p(r_{t-1} \mid x_{1:t-1})
$$

with the hazard function fixed at $H = 1/\lambda$ for an assumed mean run length $\lambda$.

Testing revealed higher accuracy under regime changes with gradually shifting variance, at the cost of memory growth proportional to the maximum run length tracked ($O(T)$ worst case, though pruning at low-probability tails kept this manageable in practice — typically under 200 active hypotheses).

Three qualitative observations from the trial runs:

- Detection quality was strongly sensitive to the hazard parameter $\lambda$.
    - Too small a $\lambda$ caused oversensitivity.
        - This manifested as spurious alarms during ordinary heavy-tailed noise spikes.
            - In one trial, over 40 false alarms were logged in a single 10,000-sample run.
    - Too large a $\lambda$ delayed detection substantially.
- Runtime scaled linearly with the number of tracked hypotheses, which required active pruning.
- The Gaussian conjugate assumption broke down on multimodal synthetic streams, requiring a fallback t-distribution model.

> [!warning]
> Without hypothesis pruning, BOCD-lite's memory footprint grew unbounded on long-running streams, eventually causing out-of-memory failures during the 72-hour soak test.

---

## 3. Sliding-Window Kernel Divergence (SWKD)

SWKD compares two adjacent windows of data, $W_1$ and $W_2$, each of length $n$, using a kernel-based divergence estimate such as a Gaussian-kernel MMD (maximum mean discrepancy) statistic:

$$
\widehat{\text{MMD}}^2(W_1, W_2) = \frac{1}{n^2}\sum_{i,j} k(x_i, x_j) - \frac{2}{n^2}\sum_{i,j} k(x_i, y_j) + \frac{1}{n^2}\sum_{i,j} k(y_i, y_j)
$$

A change is declared when this statistic exceeds a threshold calibrated via permutation testing. Because SWKD makes no parametric assumption about the underlying distribution, it performed the best on the "Halcyon-5" benchmark, which included deliberately non-Gaussian jump processes.

However, the computational cost is $O(n^2)$ per window comparison, making it the most expensive of the three by a wide margin. In practice, engineers on the team found the following process useful for tuning window size $n$:

1. Start with $n = 50$ and measure baseline false-alarm rate on a held-out calibration stream.
2. Increase $n$ in increments of 25 until latency exceeds the target SLA of 200ms per decision.
3. Re-run permutation calibration at each step, since the threshold is window-size dependent.
4. Select the smallest $n$ that satisfies both the false-alarm and latency constraints.

As one engineer summarized during the final review:

> "The kernel approach caught every synthetic anomaly we threw at it, but it cost us three times the CPU budget of the other two methods combined — a fair trade only when correctness matters more than efficiency."

---

## Summary Comparison

| Method | Latency (avg.) | False Alarm Rate | Compute Cost | Distributional Assumptions |
|---|---|---|---|---|
| CUSUM-Adaptive | 14.2 samples | 0.6% | $O(1)$ | Near-Gaussian |
| BOCD-lite | 9.8 samples | 1.4%* | $O(k)$, pruned | Conjugate (Gaussian/t) |
| SWKD | 7.1 samples | 0.3% | $O(n^2)$ | None (nonparametric) |

\*without pruning tuning; improved with careful $\lambda$ selection.

Overall, no single method dominated across all axes. For resource-constrained deployments, CA remains the pragmatic default. For latency-critical, statistically diverse streams where compute budget is generous, SWKD is preferable. BOCD-lite occupies a middle ground but requires the most careful hyperparameter stewardship to avoid the failure modes noted above.
