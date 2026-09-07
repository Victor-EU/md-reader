# Review Summary: "Adaptive Resonance Scheduling for Distributed Microgrid Networks" (Internal Draft v3.2)

**Reviewer:** J. Alderway
**Date:** March 14, 2025
**Document under review:** Technical report submitted by the Halvorsen Energy Systems Lab

---

## 1. Overview

This review covers the internal draft describing a new scheduling algorithm—referred to throughout the document as **Adaptive Resonance Scheduling (ARS)**—intended to coordinate power dispatch across a network of interconnected microgrids. The authors claim that ARS reduces peak-load variance by dynamically reallocating storage reserves based on a predictive resonance function tied to historical demand cycles.

Overall, the document is well-organized and the core algorithmic contribution appears sound, but there are several methodological gaps, unclear derivations, and presentation issues that should be addressed before this moves to external review. My comments are organized into **Findings**, **Questions**, and **Recommended Changes**, followed by a brief appendix with a worked example I used to sanity-check one of the central claims.

---

## 2. Findings

### 2.1 Strengths

1. The motivation section clearly establishes the problem: existing dispatch algorithms (the document references a baseline called "Static Priority Dispatch," or SPD) fail to adapt to correlated demand spikes across neighboring grid cells.
2. The simulation framework (Section 4) is described in enough detail that a reader could plausibly reimplement it, which is commendable — many internal drafts skip this.
3. The authors provide confidence intervals on their headline result (a 23.4% reduction in peak-load variance), which is a good practice that is often missing from earlier drafts in this series.
4. The related-work section, while brief, correctly situates ARS relative to reinforcement-learning-based dispatch methods without overstating the novelty of the resonance concept.

### 2.2 Weaknesses

> [!warning]
> The central derivation in Section 3.2 relies on an assumption of **independent and identically distributed** load fluctuations across nodes. This assumption is never justified, and it appears to contradict the paper's own motivating example, which explicitly discusses *correlated* demand spikes. This is a significant internal inconsistency that undermines the theoretical guarantees claimed in Theorem 1.

Beyond this core issue, I found the following weaknesses:

- The definition of the "resonance coefficient" $\rho$ is introduced informally in prose (Section 3.1) before it is formally defined (Section 3.3). A reader working through the document linearly will encounter $\rho$ in an equation before knowing what it represents.
- Section 4.3's ablation study omits a baseline comparison against the simplest possible variant of ARS (i.e., with the resonance term fixed at zero), which would help isolate how much of the improvement comes from the resonance mechanism itself versus other engineering changes bundled into the new algorithm.
- Several numerical results in Table 3 do not match the values plotted in Figure 5. Specifically, the reported variance reduction for the "Coastal-7" test network is listed as 18.9% in the table but appears to be closer to 21% when read off the corresponding bar in the figure.
- The document uses the terms "node," "cell," and "site" somewhat interchangeably to refer to the same concept (an individual microgrid), which creates unnecessary ambiguity, especially in Section 5 where "site" briefly seems to refer to something more granular (individual battery banks).

---

## 3. Technical Deep-Dive

### 3.1 The Resonance Function

The report defines the resonance function informally, but based on the equations in Section 3.3, I reconstruct it as follows. For a node $i$ at time step $t$, the predicted load adjustment is

$$
\hat{L}_i(t) = L_i(t-1) + \rho \sum_{j \in \mathcal{N}(i)} w_{ij}\,\big(L_j(t-1) - \bar{L}(t-1)\big)
$$

where $\mathcal{N}(i)$ is the set of neighboring nodes, $w_{ij}$ is an edge weight, and $\bar{L}(t-1)$ is the network-wide average load at the previous timestep.

This is a reasonable formulation on its face — it's essentially a graph-based mean-reversion correction — but the document never explains how $w_{ij}$ is chosen in practice, nor whether it is learned, fixed, or set by domain heuristics. In Section 4, the simulation apparently uses $w_{ij} = 1/|\mathcal{N}(i)|$ uniformly, which is a much simpler choice than the general formulation suggests. This should be stated explicitly rather than left for the reader to infer from the code appendix.

### 3.2 Convergence Claim

Theorem 1 claims that the ARS update rule converges to a fixed point under mild conditions on $\rho$. The proof sketch in Appendix B asserts, without derivation, that convergence holds whenever

$$
0 < \rho < \frac{1}{\lambda_{\max}(W)}
$$

where $\lambda_{\max}(W)$ is the largest eigenvalue of the weighted adjacency matrix $W = [w_{ij}]$. This is a plausible-looking bound reminiscent of standard spectral radius conditions for linear iterative schemes, but the proof sketch does not actually derive it — it simply states it as a "known result." I was not able to verify this claim from the material given, and I'd like to see either a citation or a full derivation.

Additionally, I attempted to reproduce a simplified version of this convergence behavior myself using a toy simulation. Below is the script I used (a minimal Python reimplementation, not part of the original submission):

```python
import numpy as np

def simulate_ars(n_nodes=6, rho=0.15, steps=200, seed=7):
    rng = np.random.default_rng(seed)
    W = rng.uniform(0, 1, size=(n_nodes, n_nodes))
    W = (W + W.T) / 2
    np.fill_diagonal(W, 0)
    W /= W.sum(axis=1, keepdims=True)  # row-normalize

    L = rng.uniform(50, 100, size=n_nodes)
    history = [L.copy()]

    for _ in range(steps):
        avg_L = L.mean()
        correction = rho * W @ (L - avg_L)
        L = L + correction
        history.append(L.copy())

    return np.array(history)

if __name__ == "__main__":
    traj = simulate_ars()
    variances = traj.var(axis=1)
    print("Final variance:", variances[-1])
    print("Initial variance:", variances[0])
```

Running this with $\rho = 0.15$ and a row-normalized $W$ (so $\lambda_{\max}(W) = 1$, comfortably satisfying the bound above) does show convergence to a near-uniform load distribution after roughly 40–60 steps in my trials. That's encouraging, but I only tested one random seed family and a single graph topology (dense, symmetric). The document's own test networks (Coastal-7, Inland-12, and Delta-Grid-9) are apparently sparser and possibly directed, which is a materially different setting. I recommend the authors run — and report — a similar sensitivity check across topologies rather than relying on a single synthetic benchmark.

---

## 4. Questions for the Authors

1. In Section 3.2, is the i.i.d. assumption meant to apply only to the *residual noise* term after resonance correction, rather than to the raw load values themselves? If so, this should be stated explicitly, since as written it reads as applying to the raw loads, which contradicts the correlated-spike motivation.
2. How was $\rho$ tuned for the reported experiments? Was it selected via grid search on a validation network distinct from the three test networks in Section 4, or was it tuned directly on Coastal-7, Inland-12, and Delta-Grid-9? If the latter, the 23.4% headline figure may be optimistic.
3. What is the computational complexity of a single ARS update step for a network with $n$ nodes and average degree $d$? The document doesn't discuss runtime at all, which is a concern for anyone considering deploying this at a scale beyond the 12-node test networks used here.
4. Table 3's discrepancy with Figure 5 (mentioned above) — which one is authoritative? Was Figure 5 perhaps generated from an earlier run of the code, before some later parameter change?
5. Is there any planned discussion of failure modes — e.g., what happens under adversarial or highly non-stationary demand patterns, such as a sudden regional outage that removes several nodes from $\mathcal{N}(i)$ mid-simulation?
6. Section 5.1 mentions a "trust region" for the correction term but does not define it mathematically or reference where it's used in the algorithm. Is this a leftover from an earlier draft?

---

## 5. Recommended Changes

1. **Resolve the i.i.d. vs. correlated-demand inconsistency.** Either relax the theoretical assumption to something compatible with correlated spikes (e.g., a covariance-based bound rather than a strict independence assumption), or explicitly scope Theorem 1 to a stationary, uncorrelated regime and clarify in the introduction that the main theoretical result does not cover the paper's own motivating scenario.
2. **Add the missing zero-resonance baseline** to the ablation study in Section 4.3, so readers can attribute performance gains specifically to the resonance mechanism.
3. **Reconcile Table 3 and Figure 5.** At minimum, add a footnote explaining any discrepancy; ideally, regenerate both from the same final run and include a hash or timestamp of the underlying data file for reproducibility.
4. **Standardize terminology.** Pick one term among "node," "cell," and "site" for the microgrid unit, and reserve a separate term (e.g., "sub-unit") for anything more granular, such as individual battery banks.
5. **Move the formal definition of $\rho$ earlier**, ideally right where it's first mentioned in Section 3.1, even if only as a forward reference ("defined formally in Eq. 7 below").
6. **Provide a full derivation or citation for the convergence bound** in Theorem 1, rather than asserting it as a known result.
7. **Report computational complexity** and, if possible, wall-clock benchmarks for at least one larger synthetic network (e.g., 100+ nodes) to give readers a sense of scalability.
8. **Clarify or remove the "trust region" reference** in Section 5.1.

---

## 6. Minor Notes

- Figure 3's y-axis label reads "Variance (MW²)" but the caption describes it as "Variance (normalized)." These should match.
- There's a typo in Section 2, paragraph 3: "Complimentary storage strategies" should presumably read "Complementary storage strategies."
- The bibliography entry for the Voskuijlen 2021 reference is missing a page range.

---

## 7. Summary Verdict

> The core idea behind Adaptive Resonance Scheduling is promising, and the empirical results, if the Table 3 / Figure 5 discrepancy is resolved in favor of the more modest numbers, still represent a meaningful improvement over the Static Priority Dispatch baseline. However, the theoretical section currently promises more than it delivers, and the internal inconsistency between the correlated-demand motivation and the i.i.d. convergence assumption needs to be resolved before this document is ready for external circulation.

> [!note]
> I'd be happy to re-review a revised draft once the authors have addressed the convergence proof and the table/figure discrepancy — those two items are, in my view, the highest-priority fixes. Everything else in this review is sec
