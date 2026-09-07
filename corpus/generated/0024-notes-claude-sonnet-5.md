# Research Notes: Streaming Changepoint Detection — Comparing Three Approaches

## Context

While evaluating drift-detection modules for the Aurelia telemetry pipeline, I compared three candidate algorithms for online changepoint detection in noisy sensor streams: **Bayesian Online Changepoint Detection (BOCD)**, the **CUSUM-Kestrel** variant developed internally, and a lightweight **Sliding-Window Energy Test (SWET)**. The goal was to identify which method best balances detection latency, false-alarm rate, and computational footprint on edge devices with roughly 40 MB of available RAM.

## Problem Setup

We assume a stream $x_1, x_2, \dots, x_t, \dots$ generated from a piecewise-stationary process, where the mean shifts at unknown times $\tau_1 < \tau_2 < \dots$. Each segment is modeled as i.i.d. draws from $\mathcal{N}(\mu_k, \sigma^2)$ for segment $k$, with $\sigma^2$ assumed roughly constant across segments (an assumption that turned out to be shakier than expected — see the warning below).

The detection objective is to estimate, at every time step $t$, the run length $r_t$ since the last changepoint, and to flag a change when the posterior probability of $r_t = 0$ exceeds a threshold $\theta$.

## Approach 1: Bayesian Online Changepoint Detection (BOCD)

BOCD maintains a full posterior distribution over run length $r_t$ using a recursive message-passing update:

$$
P(r_t \mid x_{1:t}) \propto \sum_{r_{t-1}} P(r_t \mid r_{t-1}) \, P(x_t \mid r_{t-1}, x_{1:t-1}) \, P(r_{t-1} \mid x_{1:t-1})
$$

We used a hazard function $H(r) = 1/\lambda$ with $\lambda = 250$, corresponding to an expected segment length of 250 samples. The conjugate Normal-Inverse-Gamma prior made the predictive updates closed-form, which kept per-step cost near $O(t)$ in the worst case (pruned to $O(W)$ with a run-length cap $W = 500$).

Pros observed in the Aurelia trial runs:

1. Very low false-positive rate (empirically ≈ 0.4% over 12 test streams).
2. Produces a full posterior, useful for downstream uncertainty-aware alerting.
3. Naturally handles variable segment lengths without retuning.

Cons:

- Memory grows with the run-length cap $W$; at $W=500$ we saw ~18 MB resident, uncomfortably close to our 40 MB ceiling once other services are loaded.
- Latency to detection averaged $\bar{d} \approx 34$ samples after the true changepoint, worse than CUSUM-Kestrel in high-SNR regimes.

## Approach 2: CUSUM-Kestrel

This is our team's modification of the classical cumulative sum test, adding an adaptive drift term $\delta_t$ that shrinks as confidence in the current segment mean grows. The core statistic is:

$$
S_t = \max\left(0,\; S_{t-1} + (x_t - \hat{\mu}_t) - \delta_t\right)
$$

A change is flagged when $S_t > h$, with $h = 5.2$ chosen via grid search against a held-out validation stream (stream ID `AUR-07b`).

```python
def cusum_kestrel(x, mu_hat, delta, h, S=0.0):
    """One streaming step of the CUSUM-Kestrel statistic."""
    S = max(0.0, S + (x - mu_hat) - delta)
    flagged = S > h
    return S, flagged
```

In practice this approach gave the fastest median detection latency, $\tilde{d} \approx 11$ samples, and used a trivially small memory footprint (a handful of floats). However, its performance degraded sharply when the noise variance $\sigma^2$ increased mid-stream — a scenario common in our vibration sensors during thermal cycling.

> [!warning]
> CUSUM-Kestrel assumes $\sigma^2$ is stationary. In three of the twelve test streams (notably `AUR-04`, `AUR-09`, and `AUR-11`), variance inflation of roughly 2.3x produced a burst of false alarms — as many as 9 spurious flags in a 2000-sample window. Any deployment must pair this method with a separate variance-monitoring guard.

## Approach 3: Sliding-Window Energy Test (SWET)

SWET compares the empirical distributions of two adjacent windows of length $w = 64$ using an energy-distance statistic:

$$
E_{w} = \frac{2}{w^2}\sum_{i,j} \|x_i - y_j\| - \frac{1}{w^2}\sum_{i,j}\|x_i - x_j\| - \frac{1}{w^2}\sum_{i,j}\|y_i - y_j\|
$$

where $x$ and $y$ denote the "before" and "after" windows respectively. Unlike BOCD and CUSUM-Kestrel, SWET makes no distributional assumption beyond exchangeability within each window, so it handled the variance-shift failure mode of CUSUM-Kestrel reasonably well.

The catch is cost: computing pairwise distances naively is $O(w^2)$ per step, and even with the incremental update trick (caching partial sums), our profiling showed SWET consuming roughly 3.1x the CPU cycles of CUSUM-Kestrel on the same hardware (an ARM Cortex-A53 devboard clocked at 1.2 GHz).

## Comparative Summary

| Metric | BOCD | CUSUM-Kestrel | SWET |
|---|---|---|---|
| Median latency (samples) | 27 | 11 | 19 |
| False-positive rate | 0.4% | 2.1%* | 0.9% |
| Peak RAM (MB) | 18.4 | 0.2 | 4.7 |
| Relative CPU cost | 1.6x | 1.0x | 3.1x |

\*Rises to ~5.8% under variance drift, per the warning above.

## Task List for Follow-Up Work

- [x] Reproduce BOCD results with hazard $\lambda = 250$ on streams `AUR-01` through `AUR-06`
- [x] Implement incremental SWET update to avoid recomputation each step
- [x] Draft variance-guard module to pair with CUSUM-Kestrel
- [ ] Run full 30-stream benchmark including the newly acquired `AUR-12` through `AUR-15` datasets
- [ ] Profile memory under concurrent multi-sensor deployment (currently only single-stream tested)
- [ ] Evaluate a hybrid detector that switches between CUSUM-Kestrel and SWET based on a rolling variance estimate

## Tentative Recommendation

> [!note]
> Given the RAM ceiling on edge nodes, our current recommendation is a **hybrid**: run CUSUM-Kestrel as the primary low-cost detector, gated by a lightweight variance monitor that temporarily promotes decision authority to SWET whenever the estimated $\hat\sigma^2$ deviates from its baseline by more than 1.5x. BOCD remains attractive for offline or batch reanalysis where its posterior output adds diagnostic value, but its memory profile makes it a poor fit for the smallest edge nodes in the current Aurelia fleet.

Further validation against the expanded dataset (`AUR-12`–`AUR-15`) is needed before this recommendation is finalized for production rollout.
