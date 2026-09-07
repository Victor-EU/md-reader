# Research Notes: Stiff Integrators for the Kestrel-7 Reaction Network

**Date:** internal draft, cycle 14
**Author:** working notes, simulation group

## 1. Background

The Kestrel-7 network is a toy but stubborn system of coupled reaction-rate ODEs used internally to stress-test integrators before they touch production combustion models. It has nine species, three fast-slow timescale separations, and a Jacobian condition number that spikes above $10^{6}$ near ignition. The general form is

$$
\frac{dy_i}{dt} = \sum_{j} k_{ij}(T)\, y_j - \sum_{k} k_{ik}(T)\, y_i y_k, \qquad i = 1, \dots, 9,
$$

where $k_{ij}(T)$ are Arrhenius-type rate coefficients and $T$ is a slowly varying temperature parameter. Stiffness ratio is defined here as $\rho = \lambda_{\max}/\lambda_{\min}$ over the Jacobian eigenvalues at a given state, and for Kestrel-7 $\rho$ ranges from about 40 at t=0 to over $2\times10^5$ near the ignition front.

We compared three integration strategies on this benchmark: (A) implicit Euler with full Newton iteration, (B) a fourth-order exponential integrator, and (C) a learned neural surrogate trained to emit corrector steps. The goal was not to crown a universal winner but to map the trade space of accuracy, wall-clock cost, and implementation risk.

## 2. Approach A: Implicit Euler + Newton

This is the conservative baseline. Each step solves

$$
y_{n+1} = y_n + h\, f(y_{n+1}, t_{n+1})
$$

via Newton iteration on the residual $F(y) = y - y_n - h f(y, t_{n+1})$, requiring the Jacobian $J = I - h \,\partial f/\partial y$ at every iterate. For Kestrel-7 the Jacobian is computed analytically (not finite-differenced), which matters a lot near the stiff front — finite differences there introduce noise that Newton's method amplifies.

A minimal driver loop, roughly as implemented in our test harness:

```python
import numpy as np

def implicit_euler_step(f, jac, y, t, h, tol=1e-10, max_iter=25):
    y_new = y.copy()
    for _ in range(max_iter):
        F = y_new - y - h * f(y_new, t + h)
        if np.linalg.norm(F, ord=np.inf) < tol:
            break
        J = np.eye(len(y)) - h * jac(y_new, t + h)
        delta = np.linalg.solve(J, -F)
        y_new += delta
    return y_new
```

**Observations.** Implicit Euler is unconditionally A-stable, which is the whole reason to use it here — explicit schemes need step sizes on the order of $10^{-9}\,\mathrm{s}$ to stay stable near ignition, which is impractical. In our runs, step sizes of $h \approx 4\times10^{-6}\,\mathrm{s}$ remained stable throughout, a roughly 400x speedup over RK4 in wall-clock terms for equivalent simulated time. The cost is per-step: each Newton iteration is $O(n^3)$ for the dense solve, and near the stiffest region we needed 6–9 iterations per step to hit the $10^{-10}$ residual tolerance.

> [!note]
> Order reduction is a known artifact for implicit Euler on stiff systems: even though the nominal order is 1, the *effective* local error near fast transients can behave close to zeroth order for a few steps. We saw this directly — error spiked by roughly 3x for the first four steps after the ignition front, then settled back to the expected $O(h)$ decay.

## 3. Approach B: Exponential Integrator (ETD4)

Exponential time differencing schemes split the right-hand side into a linear stiff part and a nonlinear remainder,

$$
y' = Ly + N(y, t),
$$

and integrate the linear part exactly using matrix exponentials, treating $N$ with a Runge–Kutta-like quadrature. For Kestrel-7 we used $L$ as the frozen Jacobian at the start of each macro-step and $N(y,t) = f(y,t) - Ly$.

The fourth-order ETD4RK update (Cox–Matthews style, reimplemented independently here) has the schematic form

$$
y_{n+1} = e^{hL} y_n + h\sum_{s=1}^{4} b_s(hL)\, N_s,
$$

where the $b_s(hL)$ are rational-function weights built from $\varphi$-functions ($\varphi_k(z) = \sum_{m\ge0} z^m/(m+k)!$) rather than plain polynomials. Evaluating these stably (avoiding cancellation as $hL \to 0$) is the main implementation headache; we used a contour-integral (Kassam–Trefethen) evaluation over 24 quadrature points on a circle in the complex plane around each eigenvalue cluster.

**Observations.** Once the $\varphi$-function evaluation was numerically stable, ETD4 allowed step sizes about 2.5x larger than implicit Euler for the same local error tolerance, and avoided the per-step Newton solve entirely — replaced by one matrix exponential/decomposition per macro-step (refreshed every ~50 steps rather than every step). Total wall-clock time on the benchmark dropped by roughly 35% relative to Approach A.

> [!warning]
> The frozen-Jacobian approximation degrades badly if $L$ is not refreshed often enough across the ignition front, where the true Jacobian changes character within a handful of steps. We saw solution blow-up (values exceeding $10^{4}$ in a species that should stay bounded near 1) when the refresh interval was left at the default of 50 steps without an adaptive trigger. Adding a spectral-radius-change trigger (refresh when $\|L_{\text{new}} - L_{\text{old}}\|$ exceeds 15% of $\|L_{\text{old}}\|$) fixed this.

## 4. Approach C: Neural Corrector Surrogate

The third approach trains a small feed-forward network, call it $g_\theta$, to predict a correction to a cheap explicit step:

$$
\hat{y}_{n+1} = y_n + h f(y_n, t_n) + h^2\, g_\theta(y_n, t_n, h).
$$

The network was trained on 12,000 trajectories sampled from perturbed initial conditions of Kestrel-7, using implicit-Euler reference solutions as ground truth, with a loss combining state error and a soft penalty on conservation-of-mass violation:

$$
\mathcal{L}(\theta) = \frac{1}{N}\sum_{i=1}^N \big\| \hat{y}^{(i)} - y^{(i)}_{\text{ref}} \big\|_2^2 + \lambda \left(\sum_k \hat{y}_k^{(i)} - 1\right)^2.
$$

**Observations.** In-distribution performance was excellent — errors comparable to Approach B at a fraction of the per-step cost, since inference is a single forward pass with no linear solve. But generalization was the weak point.

> Internal reviewer comment, paraphrased from the design review: "the surrogate is basically memorizing the shape of the ignition front we trained it on; push the initial temperature 8% outside the training range and the mass-conservation penalty stops helping."

That comment turned out to be accurate. When we tested initial temperatures 10% above the training envelope, the surrogate produced trajectories that violated mass conservation by up to 6%, a failure mode neither Approach A nor B exhibited (both are dissipative/conservative by construction in the relevant sense, modulo linear solver tolerance).

## 5. Comparative Summary

| Approach | Stability | Relative wall-clock | Main risk |
|---|---|---|---|
| Implicit Euler + Newton | Unconditional (A-stable) | 1.0x (baseline) | Order reduction near stiff fronts |
| ETD4 exponential integrator | Conditional on $L$ freshness | ~0.65x | Frozen-Jacobian blow-up if refresh too sparse |
| Neural surrogate | Empirical only | ~0.15x | Poor extrapolation, conservation violations |

## 6. Tentative Recommendation

For production-grade combustion runs where correctness matters more than raw speed, Approach A remains the safe default, with Approach B as a strong candidate once the adaptive refresh trigger is hardened — it offers a genuine wall-clock win without sacrificing the stability guarantees we care about. Approach C is promising as an *accelerator inside a hybrid scheme* (e.g., using the surrogate as a predictor whose output seeds Newton iteration in Approach A) rather than as a standalone integrator, since that would bound its errors by the corrector step's own convergence check instead of trusting it in isolation.

Next step: prototype the hybrid predictor-corrector variant and rerun the full Kestrel-7 sweep, including the off-distribution temperature cases that broke the pure surrogate.
