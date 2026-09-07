# Research Notes: Approaches to Streaming Rank Estimation for the Halyard Telemetry Pipeline

## 1. Problem Statement

The Halyard telemetry pipeline ingests approximately $4.2 \times 10^6$ events per minute from distributed sensor clusters and must maintain a running estimate of the effective rank of the covariance matrix $\Sigma \in \mathbb{R}^{n \times n}$ describing correlations across $n = 512$ channels. The effective rank is defined here as

$$
r_{\text{eff}}(\Sigma) = \exp\left(-\sum_{i=1}^{n} p_i \log p_i\right), \qquad p_i = \frac{\lambda_i}{\sum_{j=1}^n \lambda_j}
$$

where $\lambda_i$ are the eigenvalues of $\Sigma$. Computing $r_{\text{eff}}$ exactly at every timestep would require an eigendecomposition costing $O(n^3)$ operations, which is intractable given the pipeline's latency budget of 8 milliseconds per batch. These notes compare three candidate approaches investigated during the Q3 evaluation cycle of Project Halyard: (A) incremental Oja-style subspace tracking, (B) randomized sketch-and-solve via Gaussian projections, and (C) a hybrid moment-matching estimator developed internally, tentatively named "Fenwick-Rank."

> [!note]
> All benchmarks below were run on the Aldebaran-7 cluster (dual 32-core Kestrel processors, 256 GB RAM) using synthetic covariance streams generated from a mixture of six latent factors with additive noise variance $\sigma^2 = 0.015$. Real telemetry traces were withheld for this round pending a data-governance review scheduled for November.

## 2. Approach A: Incremental Oja Subspace Tracking

Oja's rule updates an estimate of the dominant eigenvectors using a stochastic gradient step. For a stream of centered observations $x_t \in \mathbb{R}^n$, the update for the estimated subspace $W_t \in \mathbb{R}^{n \times k}$ is

$$
W_{t+1} = \operatorname{orth}\big(W_t + \eta_t \, x_t x_t^\top W_t\big)
$$

where $\eta_t$ is a decaying learning rate, typically $\eta_t = \eta_0 / (1 + \gamma t)$, and $\operatorname{orth}(\cdot)$ denotes a QR-based re-orthonormalization applied every 64 steps to control drift.

### 2.1 Implementation Sketch

```python
import numpy as np

def oja_update(W, x, eta):
    # W: (n, k) current subspace estimate
    # x: (n,) centered observation
    Wx = W.T @ x
    grad = np.outer(x, Wx)
    W_new = W + eta * grad
    return W_new

def orthonormalize(W):
    Q, _ = np.linalg.qr(W)
    return Q

def run_oja(stream, n, k=12, eta0=0.05, gamma=1e-4, ortho_every=64):
    W = np.linalg.qr(np.random.randn(n, k))[0]
    for t, x in enumerate(stream):
        eta = eta0 / (1 + gamma * t)
        W = oja_update(W, x, eta)
        if t % ortho_every == 0:
            W = orthonormalize(W)
    return W
```

### 2.2 Observations

Oja tracking converges to the dominant $k$-dimensional subspace at a rate that empirically scaled as $O(1/\sqrt{t})$ in our trials, consistent with stochastic approximation theory for this class of update. With $k = 12$, the estimator recovered $r_{\text{eff}}$ within an absolute error of 0.31 after roughly 18,000 samples on the synthetic six-factor stream, but exhibited persistent bias when the true rank exceeded $k$, since it structurally cannot represent mass outside the tracked subspace.

Latency per update averaged 0.9 ms for $n = 512$, $k = 12$, comfortably inside budget. Memory footprint was modest at $O(nk)$.

> [!warning]
> Oja tracking is sensitive to the choice of $k$. If the underlying data-generating process gains additional latent factors mid-stream (as observed in a controlled "factor injection" test at $t = 50{,}000$), the estimator underestimates $r_{\text{eff}}$ for an extended recovery window of over 6,000 samples before the orthonormalization step reallocates capacity.

## 3. Approach B: Randomized Sketch-and-Solve

The second approach maintains a compressed sketch $S_t = \Omega^\top X_t \in \mathbb{R}^{m \times n}$ of the accumulated data matrix $X_t$, where $\Omega \in \mathbb{R}^{n \times m}$ is a fixed Gaussian random projection with $m \ll n$. The sketch is updated additively as new rows arrive, and the eigenvalue distribution of $\Sigma$ is estimated from the small $m \times m$ Gram matrix $S_t S_t^\top / t$.

The theoretical justification rests on the Johnson–Lindenstrauss-type guarantee that pairwise distances (and, by extension, spectral energy) are preserved with high probability when

$$
m \geq c \cdot \frac{\log(n/\delta)}{\epsilon^2}
$$

for constants $c$ and failure probability $\delta$. In practice we set $m = 96$ and $\epsilon = 0.08$, which the derived bound suggested would hold for $\delta = 0.01$.

### 3.1 Numerical Behavior

The sketch approach handled rank changes far more gracefully than Oja tracking: the projection $\Omega$ has no notion of a fixed subspace to saturate, so an increase in true rank is reflected immediately in the spectrum of $S_t S_t^\top$. In the factor-injection test, the estimator's error spiked briefly (peak absolute error 0.44) but returned to baseline within 900 samples.

However, the approach paid a steep computational price. Recomputing the eigenvalues of the $96 \times 96$ Gram matrix every batch cost approximately 2.1 ms, and refreshing the projection $\Omega$ periodically (to avoid numerical staleness) added a further 1.4 ms amortized over a 2,000-step refresh cycle. Total latency of 3.5 ms left less headroom than Approach A but remained within the 8 ms budget.

1. Sketch update: append new rows to $S_t$ via a running matrix-vector product, cost $O(nm)$ per sample.
2. Periodic re-basing: every 2,000 samples, recompute $\Omega$ and re-project a rolling buffer of the last 5,000 samples to avoid unbounded numerical drift.
3. Spectral read-out: eigendecompose the $m \times m$ Gram matrix and compute $r_{\text{eff}}$ from its normalized eigenvalues.
4. Bias correction: subtract an estimated noise floor derived from the known projection dimension $m$, since random projections inflate small eigenvalues.

## 4. Approach C: Fenwick-Rank Hybrid Estimator

Fenwick-Rank combines a lightweight moment-matching scheme with a small set of tracked "anchor" directions borrowed from Approach A, updated only every 200 samples rather than every sample. The key idea is that the first four traces of powers of $\Sigma$,

$$
\tau_j = \operatorname{tr}(\Sigma^j), \qquad j = 1, 2, 3, 4,
$$

can be estimated cheaply via Hutchinson-style stochastic trace estimation using random probe vectors $z_t \sim \mathcal{N}(0, I_n)$, without ever forming $\Sigma$ explicitly:

```python
def hutchinson_trace_powers(x, z, running_moments, decay=0.999):
    # x: new centered observation (n,)
    # z: random probe vector (n,)
    xz = np.dot(x, z)
    proj = xz * x  # rank-1 action of x x^T on z, approximated
    running_moments['m1'] = decay * running_moments['m1'] + (1 - decay) * np.dot(x, x)
    running_moments['m2'] = decay * running_moments['m2'] + (1 - decay) * (xz ** 2)
    return running_moments
```

The four estimated moments $\hat\tau_1, \dots, \hat\tau_4$ are then fed into a moment-matching solver that fits a five-point discrete spectral distribution $\{(\lambda_i, w_i)\}_{i=1}^5$ minimizing

$$
\min_{\{\lambda_i, w_i\}} \sum_{j=1}^4 \Big(\hat\tau_j - \sum_{i=1}^5 w_i \lambda_i^j \Big)^2 \quad \text{subject to } w_i \geq 0, \sum_i w_i = 1,
$$

after which $r_{\text{eff}}$ is computed directly from the fitted $\{w_i\}$ under the entropy formula in Section 1.

### 4.1 Findings

Fenwick-Rank achieved the lowest steady-state error of the three methods, at 0.19 absolute error against ground truth on the synthetic benchmark, and recovered from the factor-injection event within approximately 1,200 samples — slower than Approach B but considerably faster than Approach A. Its latency profile was the most favorable: 1.1 ms per update, since the moment updates are $O(n)$ per sample and the five-point spectral fit (solved via a small nonlinear least-squares routine) only needs to run once every 50 samples.

> [!note]
> The moment-matching solve occasionally failed to converge to a feasible weight vector when $\hat\tau_4$ was corrupted by probe-vector noise, producing negative weights that were clipped to zero. This occurred in about 2.3% of solve attempts during the 40,000-sample evaluation run and is flagged as an open robustness concern.

## 5. Comparative Summary

| Metric | Oja Tracking (A) | Sketch-and-Solve (B) | Fenwick-Rank (C) |
|---|---|---|---|
| Steady-state error | 0.31 | 0.27 | 0.19 |
| Recovery time after rank change | ~6,000 samples | ~900 samples | ~1,200 samples |
| Per-sample latency | 0.9 ms | 3.5 ms | 1.1 ms |
| Memory footprint | $O(nk)$ | $O(nm)$ | $O(n)$ |
| Implementation complexity | Low | Medium | Medium-High |

As one reviewer on the internal design review, R. Okonkwo-Lindqvist, put it during the September walkthrough:

> "The sketch method wins on responsiveness, but you're paying for every millisecond of that speed in cycles
