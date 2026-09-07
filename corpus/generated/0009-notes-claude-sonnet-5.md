# Research Notes: Comparing Approaches to Online Change-Point Detection in Streaming Sensor Data

## 1. Background and Motivation

Change-point detection in streaming data is a recurring problem in industrial monitoring, where a sequence of sensor readings $x_1, x_2, \dots, x_t$ is assumed to be generated from a stationary distribution until some unknown time $\tau$, after which the generating distribution shifts. The task is to detect $\tau$ as quickly as possible while controlling the *false alarm rate*.

These notes summarize an internal comparison of three candidate algorithms evaluated on a synthetic benchmark of vibration-sensor traces collected from a fictitious turbine testbed at the **Halvorsen Dynamics Lab**. The three approaches under consideration are:

1. **Kestrel-EWMA** — an exponentially weighted moving average detector with adaptive thresholding.
2. **T-BOCPD** — a Bayesian online change-point detector inspired by the Thornbury group's run-length posterior formulation.
3. **VL-SWC** — the Vasquez–Liu Sliding-Window CUSUM method, which combines a fixed-length window with a cumulative sum statistic.

The goal of this comparison was to determine which method offers the best trade-off between *detection latency*, *robustness to noise*, and *computational cost* for a deployment budget of roughly 4 milliseconds per sample on an embedded ARM controller.

> [!note]
> All numerical results below come from a simulated dataset (`turbine_synth_v3`) generated internally; no real turbine data was used. Sample rate was fixed at 500 Hz, with an injected mean-shift of magnitude $\delta = 1.2\sigma$ at a randomly chosen point in each of 400 independent trials.

---

## 2. Method 1: Kestrel-EWMA

The Kestrel-EWMA detector maintains a running statistic

$$
z_t = \lambda x_t + (1 - \lambda) z_{t-1}, \qquad z_0 = \mu_0
$$

where $\lambda \in (0,1]$ controls the memory of the filter. An alarm is raised when $|z_t - \mu_0| > L \cdot \sigma_z$, where $\sigma_z$ is the steady-state standard deviation of $z_t$ under the null hypothesis, given by

$$
\sigma_z = \sigma_0 \sqrt{\frac{\lambda}{2-\lambda}}.
$$

In practice, the Kestrel variant adapts $\lambda$ online based on a short-term estimate of local variance, which is what distinguishes it from a textbook EWMA chart.

**Strengths.** The algorithm is extremely lightweight — a single multiply-add per sample — and its behavior is well understood analytically. It handled *smoothly drifting* baselines gracefully during our stress tests, rarely triggering spurious alarms when the sensor exhibited slow thermal drift.

**Weaknesses.** Kestrel-EWMA struggled with *abrupt* shifts of small magnitude ($\delta < 0.8\sigma$). Because the exponential smoothing itself introduces lag, small shifts get absorbed into the filter's memory before crossing the threshold. In our trials, average detection delay for $\delta = 0.8\sigma$ was 142 samples (≈284 ms), which exceeded the lab's latency budget of 100 samples.

```python
def kestrel_ewma_update(x, z_prev, lam, mu0, sigma0, L=3.0):
    """One step of the Kestrel-EWMA detector."""
    z = lam * x + (1 - lam) * z_prev
    sigma_z = sigma0 * ((lam / (2 - lam)) ** 0.5)
    alarm = abs(z - mu0) > L * sigma_z
    return z, alarm
```

> [!warning]
> The adaptive $\lambda$ update in Kestrel-EWMA can become unstable if the local variance estimate is computed over too short a window (fewer than ~15 samples in our tests). This caused a burst of false alarms during the "spike noise" scenario of trial batch 7.

---

## 3. Method 2: T-BOCPD

The Bayesian online change-point detector maintains a posterior distribution over the *run length* $r_t$, defined as the number of observations since the last change point. The key recursive update is

$$
P(r_t \mid x_{1:t}) \propto \sum_{r_{t-1}} P(r_t \mid r_{t-1}) \, P(x_t \mid r_{t-1}, x_{1:t-1}) \, P(r_{t-1} \mid x_{1:t-1}).
$$

The hazard function $H(r)$ specifies the prior probability of a change point occurring after a run of length $r$; in the *Thornbury* formulation this is taken to be constant, $H(r) = 1/\theta$, corresponding to a geometric prior on the time between change points with mean $\theta$.

For Gaussian observations with unknown mean and known variance, the predictive distribution $P(x_t \mid r_{t-1}, x_{1:t-1})$ is itself Gaussian, and the sufficient statistics (mean and count) can be updated incrementally for each active run length. This gives an elegant, *exact* algorithm — no particle filtering or MCMC required, provided the observation model stays conjugate.

**Strengths.** T-BOCPD produced the *lowest average detection delay* across all tested shift magnitudes: 61 samples at $\delta = 0.8\sigma$ and only 24 samples at $\delta = 1.2\sigma$. It also naturally provides a full posterior over "how long ago" the change happened, which downstream diagnostic tools at Halvorsen found useful for root-cause analysis.

**Weaknesses.** The computational cost grows linearly with the number of tracked run-length hypotheses unless pruning is applied. In our implementation, we truncated the run-length distribution to the top 200 most probable values per step, which kept per-sample cost around 0.9 ms on the target hardware — comfortably within budget, but noticeably higher than Kestrel-EWMA's 0.03 ms.

A secondary concern is *model mismatch*: the turbine vibration data exhibited heavier tails than a Gaussian, and naive application of T-BOCPD with a Gaussian observation model led to a measurable increase in false alarms during heavy-tailed noise bursts. Switching to a Student-*t* predictive distribution alleviated this but increased per-step cost by roughly 35%.

> A colleague on the Halvorsen team remarked during a design review: *"The elegance of exact Bayesian updating is seductive, but the moment your noise model is wrong, the elegance becomes a liability."*

This observation matches our experimental findings closely and is worth keeping in mind when selecting an observation likelihood for any deployment.

---

## 4. Method 3: VL-SWC (Sliding-Window CUSUM)

The Vasquez–Liu approach computes a cumulative sum statistic over a sliding window of fixed length $W$:

$$
S_t = \max\!\left(0,\; S_{t-1} + (x_t - \mu_0) - k\right), \qquad S_0 = 0,
$$

where $k$ is a slack parameter typically set to half the anticipated shift magnitude, $k = \delta/2$. Unlike a standard (unbounded) CUSUM, the VL variant resets the accumulator whenever the window slides past $W$ samples without an alarm, which bounds memory usage and improves robustness against slow non-stationarities that are *not* true change points.

An alarm is triggered when $S_t > h$, where the threshold $h$ is chosen via a simulation-based calibration to achieve a target *average run length* (ARL) under the null hypothesis, denoted $\text{ARL}_0$. In our experiments we targeted $\text{ARL}_0 = 5000$ samples, meaning we tolerate roughly one false alarm every 10 seconds at 500 Hz.

**Strengths.** VL-SWC struck the best balance of the three methods on our composite benchmark. It achieved a detection delay of 78 samples at $\delta = 0.8\sigma$ (better than Kestrel-EWMA, though not as fast as T-BOCPD) while requiring only about 0.15 ms per sample — five to six times cheaper than the Bayesian approach. It was also the *most robust* to the heavy-tailed noise scenario, since the CUSUM statistic depends only on the sign and magnitude of deviations from $\mu_0$ rather than a full likelihood ratio.

**Weaknesses.** Choosing $k$ and $W$ requires knowledge of the expected shift magnitude in advance; performance degraded noticeably when the true shift ($\delta = 0.5\sigma$) was far smaller than the value assumed during calibration ($\delta = 1.0\sigma$). In that mismatched setting, detection delay rose to 210 samples, worse than either competitor.

```python
def vl_swc_update(x, s_prev, mu0, k, h):
    s = max(0.0, s_prev + (x - mu0) - k)
    alarm = s > h
    return s, alarm
```

---

## 5. Comparative Summary

| Metric (target: $\delta = 1.0\sigma$) | Kestrel-EWMA | T-BOCPD | VL-SWC |
|---|---|---|---|
| Mean detection delay (samples) | 118 | **34** | 55 |
| False alarms / 10k samples | 2.1 | 3.4 | **1.6** |
| Per-sample cost (ms) | **0.03** | 0.90 | 0.15 |
| Robustness to heavy tails | Moderate | Weak (Gaussian) / Moderate (Student-*t*) | **Good** |
| Tuning complexity | Low | Moderate | Moderate–High |

The table makes clear that no single method dominates across all axes. If *raw detection speed* is the overriding requirement — for instance, in a safety-critical shutdown trigger — **T-BOCPD** is the clear winner, provided the extra compute budget and a well-matched observation model are available. If *computational thrift* is paramount, as in a battery-powered edge sensor node, **Kestrel-EWMA** remains attractive despite its latency penalty on small shifts. For a *general-purpose* deployment where the shift magnitude is only approximately known in advance and heavy-tailed noise is a realistic concern, **VL-SWC** appears to offer the most balanced profile.

> [!note]
> A hybrid strategy discussed informally during the Halvorsen review — running Kestrel-EWMA as a cheap first-pass filter and only invoking T-BOCPD when the EWMA statistic crosses a *soft* threshold — was not evaluated quantitatively in this round but is flagged as a promising direction for the next benchmark cycle.

## 6. Open Questions

Several issues remain unresolved and are worth investigating in a follow-up study:

- **Sensitivity to hazard-rate missp
