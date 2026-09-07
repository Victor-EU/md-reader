# Research Notes: Streaming Covariance Estimation Strategies

**Author:** M. Ostrander
**Date:** internal draft, project *Halcyon-7*
**Context:** evaluating candidate algorithms for real-time covariance tracking on the Kestrel sensor array (14 channels, ~2 kHz sampling rate)

## 1. Problem Statement

We need to maintain an online estimate of the covariance matrix $\Sigma_t \in \mathbb{R}^{d \times d}$ for a stream of vector observations $x_1, x_2, \dots, x_t \in \mathbb{R}^d$, where $d = 14$. The estimator must run under a strict *per-sample* compute budget of 40 microseconds on the embedded Kestrel controller, must be numerically stable over runs lasting several days, and should gracefully track slow drift in the underlying signal statistics (e.g., thermal effects on the sensor housing).

Three candidate approaches were prototyped this quarter: (A) an **exponential moving average (EMA)** covariance tracker, (B) a **Welford-style incremental** estimator generalized to matrices, and (C) a **randomized sketch-based** covariance approximation using Johnson–Lindenstrauss-style projections. This note summarizes their derivations, tradeoffs, and benchmark results on the synthetic "Aurelia-9" dataset we generated for stress-testing.

---

## 2. Approach A — Exponential Moving Average Covariance

The EMA approach updates a running mean $\mu_t$ and covariance $\Sigma_t$ using a fixed decay factor $\alpha \in (0,1)$:

$$
\mu_t = (1-\alpha)\mu_{t-1} + \alpha x_t, \qquad
\Sigma_t = (1-\alpha)\Sigma_{t-1} + \alpha (x_t - \mu_t)(x_t - \mu_t)^\top
$$

The parameter $\alpha$ controls the *effective window length*, roughly $1/\alpha$ samples. Small $\alpha$ gives smooth, stable estimates but reacts slowly to drift; large $\alpha$ tracks drift quickly but is noisy.

This method is extremely cheap — a single rank-one update per sample, $O(d^2)$ multiply-adds — and requires no stored history. It was our default baseline going into this evaluation.

**Strengths**

- Trivial to implement in fixed-point arithmetic
- Constant memory: only $\mu_t$ and $\Sigma_t$ need to be stored
- Naturally forgets stale data, which is *desirable* for the Kestrel's slowly drifting bias

**Weaknesses**

- Choosing $\alpha$ is a fragile hyperparameter search; wrong choice can bias variance estimates by 15–20% in our synthetic trials
- Not a *consistent* estimator of stationary covariance — it always carries some bias-variance tradeoff baked in by construction
- Sensitive to outliers, since a single large $x_t$ can distort $\Sigma_t$ for several subsequent samples

> [!warning]
> During the Aurelia-9 stress test, an $\alpha = 0.05$ EMA tracker lost synchronization for **11 seconds** after a simulated sensor glitch injected a single 40$\sigma$ outlier. Any deployment of Approach A must include a robust clipping or Huberization step upstream.

---

## 3. Approach B — Welford-Generalized Incremental Covariance

The classical *Welford* algorithm for scalar variance generalizes cleanly to the matrix case. Maintaining a running mean $\mu_t$ and an unnormalized scatter matrix $M_t$, the update rule is:

```python
def welford_update(mean, M, n, x):
    n += 1
    delta = x - mean
    mean += delta / n
    delta2 = x - mean
    M += outer(delta, delta2)
    return mean, M, n

def covariance(M, n):
    return M / (n - 1) if n > 1 else zeros_like(M)
```

Here `outer(a, b)` denotes the outer product $a b^\top$. This is *numerically superior* to the naive sum-of-squares formula because it avoids catastrophic cancellation when $\mu_t$ is large relative to the variance — a known failure mode we've hit before on the Aurelia-6 dataset.

Unlike Approach A, this is an *unbiased, exact* running estimator of covariance over the entire observed history — every sample counts equally, with no forgetting. That is both its main asset and its main liability for our use case, since the Kestrel array genuinely experiences non-stationary drift.

A drift-aware variant introduces a sliding window of length $W$, discarding the oldest sample's contribution via a corresponding "downdate" rule:

$$
M_t^{(W)} = M_{t-1}^{(W)} + \frac{n}{n-1}\,\delta_t \delta_t^\top - \frac{n}{n-1}\,\delta_{t-W}\delta_{t-W}^\top
$$

where $\delta_t = x_t - \mu_t$. This restores the ability to track drift, at the cost of storing the last $W$ raw samples — a $O(Wd)$ memory footprint.

**Task list for Approach B validation:**

- [x] Implement scalar Welford update and confirm against NumPy `var()` baseline
- [x] Generalize to matrix scatter update
- [x] Verify numerical stability under large mean offset ($\mu \approx 10^6$)
- [x] Implement sliding-window downdate
- [ ] Profile downdate cost on Kestrel fixed-point hardware
- [ ] Stress-test under injected outliers (comparable to Approach A's test)

So far, results are *promising*: the windowed Welford variant matched batch covariance to within $10^{-6}$ relative error on all synthetic trials completed to date, and it appears robust to the mean-shift pathologies that plague naive accumulation.

---

## 4. Approach C — Randomized Sketch-Based Covariance

The third approach avoids materializing $\Sigma_t$ at all. Instead we maintain a random projection $Y_t = x_t^\top S \in \mathbb{R}^{k}$, where $S \in \mathbb{R}^{d \times k}$ is a fixed random Gaussian matrix with $k \ll d$ (we used $k = 6$ for $d = 14$). A rolling second-moment matrix is tracked in the reduced $k$-dimensional space:

$$
\Sigma_t \approx S \, \hat{\Sigma}^{(k)}_t \, S^\top, \qquad \hat{\Sigma}^{(k)}_t = \frac{1}{t}\sum_{i=1}^{t} y_i y_i^\top
$$

By the Johnson–Lindenstrauss lemma, pairwise distances (and hence second-moment structure) are approximately preserved with high probability when $k = O(\varepsilon^{-2} \log d)$, though in practice we tuned $k$ empirically rather than via the theoretical bound, which was overly conservative for our $d=14$ regime.

This is attractive because the per-sample update cost drops from $O(d^2)$ to $O(dk + k^2)$, a meaningful savings when $d$ grows (we anticipate a future Kestrel-II array with $d = 64$). However, reconstructing the full $\Sigma_t$ for downstream consumers (e.g., a Kalman filter expecting a full covariance) requires the projection-back step $S \hat\Sigma^{(k)}_t S^\top$, which reintroduces $O(d^2 k)$ cost whenever the full matrix is actually needed — so savings only materialize if downstream consumers can operate directly in the sketch space.

**Strengths**

- Scales gracefully to high-dimensional future hardware
- Memory footprint is $O(k^2)$ instead of $O(d^2)$ — a genuine win once $d > 40$ or so
- ==Naturally regularizes against small-sample overfitting== in the early "burn-in" period, since $\hat\Sigma^{(k)}$ has far fewer free parameters

**Weaknesses**

- Introduces irreducible approximation error even at convergence — measured empirically around 6–9% relative Frobenius error for $k=6, d=14$ on Aurelia-9
- Reconstructed covariance is *low-rank plus noise*, not full-rank, which can confuse consumers expecting a well-conditioned matrix
- Debugging is harder: errors are diffuse across the projection rather than attributable to a specific channel

> [!note]
> For the current Kestrel-I hardware ($d=14$), the sketch-based approach is *not* clearly justified — the dimensionality is too low for the asymptotic memory/compute wins to outweigh the approximation error. It becomes attractive primarily as a **forward-looking** option for Kestrel-II.

---

## 5. Summary Comparison

| Criterion | A: EMA | B: Windowed Welford | C: Sketch-based |
|---|---|---|---|
| Compute per sample | $O(d^2)$, very low constant | $O(d^2)$, higher constant | $O(dk+k^2)$ |
| Memory | $O(d^2)$ | $O(d^2 + Wd)$ | $O(k^2)$ |
| Drift tracking | native, tunable | via window $W$ | via window (untested) |
| Numerical stability | moderate | *strong* | strong (bounded by $k$) |
| Outlier sensitivity | high | moderate | moderate |
| Best suited for | quick prototyping | current Kestrel-I deployment | future high-$d$ hardware |

**Recommendation:** adopt Approach B (windowed Welford) as the production candidate for the Kestrel-I deployment, pending completion of the outstanding profiling and outlier-robustness tasks above. Approach C should remain an active research thread for the Kestrel-II design cycle, and Approach A should be retained only as a lightweight fallback for contexts where compute is more constrained than the 40 μs budget assumed here.
