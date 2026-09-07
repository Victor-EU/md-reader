# Review Summary: *Adaptive Thermal Regulation in Modular Reactor Cores* (Draft v3.2)

**Reviewer:** Dr. Elena Vasquez
**Date:** March 2025 (internal draft)

## Overview

This document presents a proposed framework for adaptive thermal regulation in modular reactor cores, authored by the Kestrel Systems engineering group. The draft introduces a control-loop architecture (referred to throughout as the *Harrow Model*) intended to reduce thermal drift in segmented core arrays. Overall, the technical approach is promising, but several sections require clarification and additional support before this can move to formal review.

---

## Key Findings

1. The **core thermal decay function** is well-motivated but underspecified in Section 4.
2. The simulation results in Appendix C show *inconsistent* units between Table C.2 and Figure C.4 — this needs correction.
3. The proposed feedback gain constant, $k_p$, lacks a clear derivation; it appears to be chosen empirically without justification.
4. Several claims about long-term stability are asserted without citation or supporting data, which weakens the credibility of Section 6.
5. The notation for the coupling coefficient shifts between $\lambda$ and $\lambda_c$ without explanation, causing confusion in cross-referenced equations.

> [!note]
> The authors likely intended $\lambda$ and $\lambda_c$ to represent the same quantity across different reactor segments, but this should be stated explicitly rather than left implicit.

---

## Technical Concerns

The central stability criterion presented in Section 5 is given as:

$$
\frac{d T_i}{dt} = -k_p (T_i - T_{\text{ref}}) + \sum_{j \neq i} \lambda_{ij} (T_j - T_i)
$$

This equation is reasonable in form, but the document never explains how $\lambda_{ij}$ is measured or bounded. Without constraints on $\lambda_{ij}$, the system's stability proof in Appendix B is incomplete. A reviewer cannot verify that the eigenvalues of the resulting coupling matrix remain negative under all proposed operating conditions.

> [!warning]
> If $\lambda_{ij}$ is allowed to vary without bound, the stability argument in Appendix B may not hold for extreme configurations. This should be addressed before submission.

The pseudocode provided for the control loop is a helpful addition, but it does not match the equations in Section 5 precisely — the update step appears to omit the coupling term entirely.

```python
def update_temperature(T, T_ref, kp, dt):
    # NOTE: missing coupling term (lambda_ij) from Section 5
    dT = -kp * (T - T_ref)
    return T + dT * dt
```

This inconsistency between prose, math, and code is a recurring issue and should be resolved by the next revision.

---

## Questions for the Authors

- How was the empirical value of $k_p$ determined, and across how many trial configurations?
- Is $\lambda_{ij}$ assumed symmetric ($\lambda_{ij} = \lambda_{ji}$)? This is never stated.
- Why does Appendix C use different temperature units (Kelvin vs. normalized units) from the main text?
- Are the long-term stability claims in Section 6 based on simulation, physical testing, or both?

---

## Recommended Changes

- ==Standardize notation== for the coupling coefficient throughout the document.
- Provide a derivation or empirical justification for $k_p$.
- Correct the mismatch between the pseudocode and the governing equations.
- Add citations or data references to support the stability claims in Section 6.
- Reconcile units between Appendix C tables and figures.

---

As one internal reviewer noted during the preliminary review cycle:

> "A model is only as convincing as its weakest unexplained constant."

This sentiment captures the core issue here — the *underlying* architecture is sound, but the supporting justification needs strengthening throughout. With the revisions above, this draft should be in strong shape for the next review milestone.
