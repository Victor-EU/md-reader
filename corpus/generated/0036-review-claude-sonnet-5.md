# Review Summary: "Adaptive Resonance Filtering for Distributed Sensor Networks" (Working Draft v3.2)

## Overview

This review covers the internal draft submitted by the Kestrel Labs signal processing group, authored under the working title *Adaptive Resonance Filtering for Distributed Sensor Networks*. The document proposes a new filtering architecture — referred to throughout as **ARF-Net** — intended to reduce false-positive detection rates in low-power distributed sensor arrays. Overall, the manuscript is well organized and the core algorithmic contribution appears sound, but there are several methodological gaps, unclear derivations, and presentation issues that should be addressed before this moves to external review.

> [!note]
> This summary reflects a single-pass technical review conducted by the internal methods committee (reviewers: R. Alcazar, T. Ndiaye, and M. Okonkwo-Fields). It is not a substitute for a full statistical audit.

---

## High-Level Findings

### Strengths

- The motivation section clearly frames the problem of *sensor drift* in long-duration deployments and does a good job distinguishing it from ordinary sensor noise.
- The proposed resonance kernel is a genuinely interesting reformulation of the classical Kalman-style update, and the authors' claim that it reduces computational overhead by roughly 40% relative to their baseline (referred to as **BFK-7**) is plausible given the simplified update rule.
- Section 4's ablation study is thorough and covers a reasonable number of configurations (14 total, spanning three noise regimes).
- The writing is generally clear, though dense in places (see below).

### Weaknesses

- **Undefined notation**: The symbol $\theta_t$ is introduced in Section 2.1 as a "resonance parameter" but is never formally defined in terms of the underlying state-space model. Readers are left to infer its role from context.
- **Inconsistent experimental setup**: Table 3 reports results for "Network Configuration B" but the appendix describes only configurations A, C, and D. It's unclear whether this is a typo or a missing configuration description.
- The claim that ARF-Net achieves *"near-optimal"* convergence is not substantiated by a formal proof or even an informal argument — this term is used three times in the document without qualification.
- Several of the reported confidence intervals appear implausibly tight given the stated sample sizes (see Statistical Concerns below).

---

## Detailed Technical Notes

### 1. The Core Update Rule

The paper's central contribution is the modified update equation, which the authors write informally in prose but never present as a standalone equation. For clarity, I reconstruct what I believe is the intended formulation:

$$
\hat{x}_{t+1} = \hat{x}_t + \kappa_t \left( z_t - H \hat{x}_t \right) + \lambda \sum_{i=1}^{N} w_i \, \phi(\hat{x}_t - \hat{x}_t^{(i)})
$$

where $\hat{x}_t$ is the local state estimate, $z_t$ is the observed measurement, $H$ is the observation matrix, $\kappa_t$ is a time-varying gain, and the second term represents the "resonance coupling" across neighboring nodes $i = 1, \dots, N$ with weights $w_i$ and coupling function $\phi(\cdot)$.

**This reconstruction should be verified with the authors** — if it is correct, it belongs explicitly in the main text rather than being left implicit. If incorrect, the ambiguity itself is a serious presentation flaw.

A related concern: the gain term $\kappa_t$ is described as "adaptively tuned" but no update rule is given for $\kappa_t$ itself. Is it a fixed schedule, a learned parameter, or computed via a secondary optimization (e.g., minimizing $\mathbb{E}[\|\hat{x}_t - x_t\|^2]$ at each step)? This needs clarification.

### 2. Statistical Concerns

The reported results in Table 5 show a mean detection latency of *38.2 ms* with a 95% confidence interval of *[37.9, 38.5]* across only **22 trials**. This interval seems narrow given the sample size and the reported standard deviation of *4.1 ms* elsewhere in the same table — these two numbers are not mutually consistent under a standard $t$-distribution assumption. Either:

1. the standard deviation is a typo (perhaps it should be *0.41 ms*), or
2. the confidence interval was computed incorrectly, or
3. the trials are not independent and some form of clustering/bootstrap correction was applied but not described.

> [!warning]
> This inconsistency, if unresolved, undermines confidence in **all** reported intervals in Sections 4 and 5. I recommend a full recomputation and a clear statement of the statistical method used (bootstrap, normal approximation, etc.).

### 3. Reproducibility

The appendix includes a partial code listing for the coupling function $\phi(\cdot)$, but it is incomplete — it references a helper function `normalize_weights()` that is never defined. Below is the listing as it appears, annotated with a missing-piece flag:

```python
def resonance_update(x_hat, neighbors, weights, lam=0.15):
    # weights should sum to 1 across neighbors
    w = normalize_weights(weights)  # <-- undefined elsewhere in appendix
    coupling = sum(w[i] * phi(x_hat - neighbors[i]) for i in range(len(neighbors)))
    return x_hat + lam * coupling

def phi(delta):
    return delta / (1 + abs(delta))
```

The `phi` function itself is a reasonable soft-saturation nonlinearity, and it's helpful that the authors included it explicitly — this is one of the few places in the document where implementation details are concrete enough to reproduce. I'd strongly recommend expanding this appendix so the *entire* pipeline can be reconstructed by a reader who did not participate in the original experiments.

### 4. Terminology and Framing

The term "resonance" is used somewhat loosely throughout — at times it refers to the coupling mechanism between nodes, and at other times it seems to refer to a temporal oscillation in the estimate itself (Section 3.4, paragraph 2). These are *related but distinct* phenomena and conflating them makes the theoretical contribution harder to evaluate. I recommend the authors settle on one precise usage and define it early, ideally in Section 1.

Additionally, the phrase "*near state-of-the-art*" appears in the abstract without a citation to what the actual state-of-the-art baseline is. Given that BFK-7 is described later as the primary comparison point, it would help to name it in the abstract directly.

---

## Minor Issues

- Figure 6's y-axis is unlabeled — I assume it is "false positive rate" based on the caption, but this should be explicit.
- The bibliography has at least one broken cross-reference: citation `[Okafor19]` is referenced in Section 3 but does not appear in the reference list.
- Section 2.3 uses the phrase "*trivially follows*" to describe a derivation that, on inspection, took the reviewers about fifteen minutes to reconstruct. Consider either providing the intermediate steps or softening the language.
- There are a handful of inconsistent capitalizations of "ARF-Net" vs. "ARFNet" vs. "arf-net" scattered through the text.

---

## Questions for the Authors

1. Is $\theta_t$ intended to be equivalent to $\kappa_t$ in the update rule, or are these genuinely separate quantities? The current text seems to conflate them in at least two places.
2. What is the actual network topology used for the "Configuration B" experiments referenced in Table 3? Is this a ring, star, or fully-connected topology?
3. Was $\lambda$ (the coupling strength) held fixed across all experiments, or was it tuned per configuration? If tuned, what was the search procedure?
4. Regarding the confidence interval discrepancy in Table 5 — can the authors confirm whether trials were treated as independent, and if not, what correction (if any) was applied?
5. Is there a theoretical convergence guarantee for ARF-Net under bounded but adversarial noise, or is the "near-optimal" language purely empirical?

---

## Recommended Changes

- [x] Add an explicit, numbered equation for the core update rule (Section 2.1).
- [x] Clarify the relationship between $\theta_t$ and $\kappa_t$, or merge the notation if they are the same quantity.
- [ ] Resolve the missing "Configuration B" description in the appendix.
- [ ] Recompute and double-check all confidence intervals in Tables 4 and 5.
- [ ] Define `normalize_weights()` in the code appendix, or remove the reference if it's a leftover from an earlier draft.
- [ ] Standardize capitalization of "ARF-Net" throughout the manuscript.
- [ ] Fix the broken citation to `[Okafor19]` or remove it.
- [ ] Add axis labels to Figure 6.
- [ ] Either prove or soften the "near-optimal convergence" claim in the abstract and conclusion.

---

## Overall Recommendation

This draft demonstrates a *promising* architectural idea with reasonably strong empirical support, but it is **not yet ready** for external submission. The statistical inconsistencies in particular (see Section 2 of this review) are the kind of issue that reviewers at an external venue would likely flag immediately, and it would be far better to resolve them internally first. The notation and terminology issues, while less severe, compound the difficulty of evaluating the paper's core claims.

My overall assessment is that this needs a **moderate revision pass** — likely two to three weeks of focused work — rather than a full rewrite. The underlying contribution seems real; what's missing is the rigor and clarity needed to make that contribution legible to an outside reader. I'd recommend a follow-up internal review once the confidence-interval issue and the missing appendix content have been resolved, since those two items alone affect how much weight can be placed on the empirical claims in Sections 4 and 5.

Finally, I want to flag that the collaborative tone of the writing is a genuine strength — the paper reads as though the authors are inviting scrutiny rather than avoiding it, which made this review easier to conduct in good faith. That spirit should be preserved even as the technical issues above are addressed.
