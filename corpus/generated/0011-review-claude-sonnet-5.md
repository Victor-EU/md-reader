# Review Summary: "Adaptive Momentum Scaling for Non-Convex Optimization" (Draft v3.2)

## Overview

This review covers the internal draft submitted by the Algorithms & Systems group, authored under the working title *Adaptive Momentum Scaling* (AMS). The document proposes a modification to standard momentum-based optimizers by introducing a per-parameter scaling term derived from a rolling estimate of gradient curvature. Overall, the manuscript is **well-structured** and the core idea is *plausible*, but several theoretical claims require tightening, and the empirical section needs additional baselines before this can be considered ready for external submission.

> [!note]
> This review was conducted over two passes: a theoretical audit of Sections 3–4 and an empirical audit of Sections 5–6. Reviewer notes are consolidated below rather than presented inline to avoid fragmenting the discussion.

---

## 1. Summary of Contributions

The authors claim three primary contributions:

1. A new update rule that scales the momentum term by an adaptive factor $\alpha_t$, computed from a windowed curvature estimate.
2. A convergence proof for the non-convex, smooth setting under bounded gradient variance.
3. An empirical evaluation across four benchmark tasks (image classification, language modeling, tabular regression, and reinforcement learning) showing modest but consistent improvements over **Adam** and *SGD with Nesterov momentum*.

The central update rule, as presented in Equation 7 of the draft, is:

$$
\theta_{t+1} = \theta_t - \eta \left( \alpha_t m_t + (1 - \alpha_t) g_t \right), \qquad \alpha_t = \sigma\!\left(\lambda \cdot \hat{c}_t\right)
$$

where $\hat{c}_t$ is the curvature estimate, $\sigma(\cdot)$ is a sigmoid squashing function, and $\lambda$ is a hyperparameter controlling sensitivity. The idea of blending raw gradient $g_t$ and momentum $m_t$ via a learned or estimated gate is reasonable, but the specifics of how $\hat{c}_t$ is computed (Section 3.2) are underspecified.

---

## 2. Theoretical Findings

### 2.1 Convergence Proof (Section 4)

The proof sketch in Section 4.1 attempts to bound the expected gradient norm over $T$ iterations:

$$
\mathbb{E}\left[\frac{1}{T}\sum_{t=1}^{T} \|\nabla f(\theta_t)\|^2\right] \leq \frac{2(f(\theta_1) - f^*)}{\eta T} + \frac{\eta L \sigma^2}{2}
$$

This bound is structurally similar to standard SGD convergence results, which raises a question: **does the adaptive scaling term $\alpha_t$ actually contribute to a tighter bound, or does it wash out asymptotically?** As written, the proof does not isolate the contribution of $\alpha_t$ distinctly from the constant $L$ (smoothness parameter), which weakens the claimed novelty of the theoretical result.

> [!warning]
> The proof in Appendix B, Lemma 3, appears to assume that $\hat{c}_t$ is **independent** of the stochastic gradient noise at step $t$. This assumption is not justified anywhere in the text and may not hold in practice, since curvature estimates are typically computed from the same minibatch gradients used for the update. This should be flagged as a potential soundness gap.

### 2.2 Definition Ambiguity

The variable $\hat{c}_t$ is introduced informally as "a smoothed estimate of local curvature" but is never given a precise closed-form definition outside of a footnote. The footnote states it is computed via a finite-difference approximation, roughly:

- $\hat{c}_t \approx \dfrac{\|g_t - g_{t-1}\|}{\|\theta_t - \theta_{t-1}\|}$

This is a reasonable proxy for curvature magnitude, but:
  - It is **not** the same as a Hessian-vector product, despite the paper implicitly suggesting an equivalence in the discussion (Section 3.3, paragraph 2).
  - No numerical safeguards are mentioned for the case where $\|\theta_t - \theta_{t-1}\|$ is near zero, which will occur frequently near convergence.
    - This could cause $\hat{c}_t$ to spike, destabilizing $\alpha_t$.
    - A clipping or epsilon-smoothing mechanism should be added.
      - Suggested form: $\hat{c}_t \approx \dfrac{\|g_t - g_{t-1}\|}{\|\theta_t - \theta_{t-1}\| + \epsilon}$, with $\epsilon \approx 10^{-8}$.

---

## 3. Empirical Findings

### 3.1 Benchmark Coverage

The four tasks chosen (image classification on a 50-class subset, a mid-sized language model of roughly 340M parameters, a tabular regression task with synthetic noise, and a reinforcement learning control task) are a reasonable spread, but the **baselines are incomplete**. Specifically:

1. There is no comparison against **AdamW**, which has largely superseded plain Adam in practice for the language modeling domain.
2. There is no learning-rate warmup ablation, despite AMS being sensitive to $\lambda$ in early training according to the authors' own Figure 6.
3. Only a single random seed is reported per configuration — this is insufficient to support claims of "consistent improvement," which implies statistical reliability across runs.

### 3.2 Reported Results

The reported improvements are modest: roughly 0.4–1.2% relative improvement in final validation metric across tasks. While *directionally* positive, the paper does not report confidence intervals or variance across seeds, so it is difficult to assess whether these improvements are meaningful or within noise.

> The authors write: "AMS demonstrates a clear and consistent advantage across all evaluated domains, suggesting broad applicability of curvature-aware momentum scaling."

This claim is **too strong** given the single-seed evidence. I recommend softening this language substantially until multi-seed results are available.

### 3.3 Code Snippet Review

The appendix includes a minimal PyTorch-style implementation snippet. The logic is broadly sound, but there is a subtle bug: the curvature estimate uses `grad_prev` before it has been updated on the first step, which will raise a `NoneType` error unless guarded.

```python
def ams_step(param, grad, grad_prev, param_prev, momentum, lam, eta, eps=1e-8):
    if grad_prev is None:
        curvature = 0.0
    else:
        num = (grad - grad_prev).norm()
        den = (param.data - param_prev.data).norm() + eps
        curvature = (num / den).item()

    alpha = 1 / (1 + math.exp(-lam * curvature))
    momentum.mul_(alpha).add_(grad, alpha=(1 - alpha))
    param.data.add_(momentum, alpha=-eta)
    return momentum, curvature
```

This fixes the first-step issue by guarding against `grad_prev is None`, but the actual submitted code in Appendix C does **not** include this guard. This should be corrected before release, since it would crash on step 1 of any training run.

---

## 4. Minor Issues and Presentation Notes

- Figure 4 axis labels are swapped (x-axis is labeled "epoch" but the data appears to be per-step, based on the scale of ~50,000 ticks).
- Table 2 caption references "Model B" but no such model is defined anywhere in Section 5; likely a leftover from an earlier draft revision.
- The related work section (Section 2) does not cite any curvature-aware adaptive methods outside the authors' own prior workshop paper, which is a notable gap — there is a reasonably large literature on Hessian-free and quasi-Newton-inspired stochastic optimizers that should be discussed for context.
- Several instances of inconsistent notation: $\eta$ is used both as the learning rate and, in Section 6.2, apparently as an early-stopping threshold. These should be disambiguated with distinct symbols.

---

## 5. Recommended Changes

Before this draft proceeds to external review, I recommend the following, roughly in priority order:

1. **Fix the independence assumption** in Lemma 3 or explicitly acknowledge it as a simplifying assumption with a discussion of its limitations.
2. **Add numerical safeguards** ($\epsilon$-smoothing) to the curvature estimate and clarify this in both the text and the reference implementation.
3. **Expand empirical evaluation**:
   - Add AdamW as a baseline for the language modeling task.
   - Run at least 3–5 seeds per configuration and report variance or confidence intervals.
   - Include the missing warmup ablation referenced in Figure 6.
4. **Soften overclaiming language** in the abstract and conclusion to match the actual strength of the evidence.
5. **Correct the code appendix** to match the guarded implementation shown above, and add a unit test for the first-step case.
6. **Fix figure/table inconsistencies** (Figure 4 axis labels, Table 2 "Model B" reference).
7. **Expand related work** to situate AMS relative to existing curvature-aware and quasi-Newton-style stochastic methods.

---

## 6. Overall Recommendation

**Verdict: Major revision required.** The core idea behind AMS is interesting and potentially useful, but the theoretical contribution needs a clearer isolation of what the adaptive term actually buys over standard momentum, and the empirical section needs substantially more rigor (multiple seeds, additional baselines, corrected code) before the claims can be considered well-supported. I would be glad to review a revised version once these issues are addressed.
