# Review Summary: "Adaptive Resonance Scheduling for Distributed Compute Clusters" (Draft v3.2)

## Overview

This review covers the internal technical report submitted by the Halcyon Systems Group describing a new scheduling algorithm — referred to throughout as **ARS-7** — intended for use in heterogeneous compute clusters. The document proposes a resonance-based priority function for job placement and claims a 23% improvement in average queue latency over the baseline Round-Robin-Weighted (RRW) scheduler. This summary consolidates findings from three independent reviewers (Nadia Ferro, Callum Osei, and Priya Venkat) into a single set of observations, questions, and recommendations.

---

## 1. Summary of Findings

### 1.1 Strengths

The core contribution — a dynamically weighted priority score $\pi_i$ for job $i$ — is conceptually sound and builds naturally on prior queueing-theoretic work. The authors define the priority function as:

$$
\pi_i = \alpha \cdot \frac{1}{w_i + \epsilon} + \beta \cdot \frac{c_i}{C_{\max}} - \gamma \cdot \log(1 + d_i)
$$

where $w_i$ is wait time, $c_i$ is requested compute share, $C_{\max}$ is cluster capacity, $d_i$ is deadline slack, and $\alpha, \beta, \gamma$ are tunable coefficients. This formulation is elegant and the derivation in Appendix B is mostly rigorous.

Reviewers agree that the simulation methodology (Section 5) is well-documented, and the benchmark suite (12 synthetic workloads plus 2 traces from the fictional "Meridian Cloud" dataset) is a reasonable proxy for production behavior.

### 1.2 Weaknesses

1. **Insufficient sensitivity analysis.** The coefficients $\alpha = 0.42$, $\beta = 0.31$, $\gamma = 0.27$ appear to have been tuned on the same dataset used for evaluation, raising concerns about overfitting.
2. **Missing failure-mode discussion.** There is no analysis of what happens when $w_i \to \infty$ for starved low-priority jobs — the formula suggests $\pi_i \to \alpha/\epsilon$, a bounded value, but the paper never discusses whether this bound is actually reachable in practice or whether starvation is empirically observed.
3. **Ambiguous notation.** The symbol $d_i$ is used both for "deadline slack" (Section 3) and "node degree" (Section 6), which is confusing and likely a copy-paste artifact.
4. **Reproducibility gap.** No pseudocode or reference implementation is provided; the described algorithm cannot currently be reproduced from the text alone.

> [!warning]
> The lack of a public or internal reference implementation is a blocking issue for acceptance. Reviewers were unable to verify the claimed 23% latency improvement independently.

---

## 2. Detailed Comments by Section

### Section 2 — Related Work

The related work section is thin. It cites only four prior scheduling systems (Thistlewood, Kestrel-Q, Vantablack Scheduler, and Orinoco) and omits any comparison to gang-scheduling or bin-packing heuristics, which seem highly relevant given the workload characteristics described in Section 4.

### Section 3 — Algorithm Design

The resonance metaphor (jobs "resonating" with available nodes based on affinity scores) is intuitive but under-formalized. A worked example would help. Reviewer Osei suggested the following minimal pseudocode be added to clarify the placement loop:

```python
def schedule(jobs, nodes, alpha=0.42, beta=0.31, gamma=0.27, eps=1e-6):
    for job in sorted(jobs, key=lambda j: -priority(j, alpha, beta, gamma, eps)):
        best_node = max(nodes, key=lambda n: affinity(job, n))
        if best_node.has_capacity(job):
            assign(job, best_node)
        else:
            requeue(job)
    return nodes

def priority(job, alpha, beta, gamma, eps):
    return (alpha / (job.wait + eps)
            + beta * (job.compute_share / job.cluster_capacity)
            - gamma * math.log(1 + job.deadline_slack))
```

This kind of concrete listing would substantially improve reproducibility and should be added as Appendix C.

### Section 4 — Workload Model

The workload generator assumes job arrival follows a Poisson process with rate $\lambda = 14.5$ jobs/minute, but real cluster traces (per Ferro's prior experience with the "Solstice" production cluster) tend to be bursty and better modeled by a Hawkes process. This assumption should at least be acknowledged as a limitation.

### Section 5 — Evaluation

The comparison baselines (RRW and FIFO-Weighted) are reasonable, but the absence of a comparison against a modern learned scheduler (e.g., a reinforcement-learning-based approach) weakens the claim of state-of-the-art performance. Additionally, confidence intervals are missing from Table 4; only point estimates are reported.

### Section 6 — Fault Tolerance

This section is the weakest in the document. The claim that ARS-7 "gracefully degrades" under node failure is not substantiated with any experiment involving simulated node churn. Reviewer Venkat recommends at minimum a 5% and 15% node-failure injection experiment.

---

## 3. Questions for the Authors

1. How were the coefficients $\alpha$, $\beta$, and $\gamma$ selected — via grid search, Bayesian optimization, or manual tuning? Please report the search space and validation split used.
2. Is the epsilon term $\epsilon$ in the priority function a fixed constant across all experiments, or does it vary by workload type?
3. What is the computational complexity of the scheduling loop per epoch? The paper implies $O(n \log n)$ but does not derive this explicitly.
4. Why was the Meridian Cloud trace truncated to 48 hours rather than using the full 7-day trace available in the appendix data release?
5. Can the authors clarify whether "resonance" in the title is meant literally (i.e., tied to some oscillatory signal in the affinity computation) or is purely metaphorical naming?

---

## 4. Recommended Changes

The following changes are recommended before the document proceeds to the next review cycle:

- [x] Disambiguate the overloaded symbol $d_i$ throughout Sections 3 and 6.
- [x] Add a reference implementation or detailed pseudocode (see Section 3 draft above) as an appendix.
- [ ] Include confidence intervals or variance bars in all latency comparison tables.
- [ ] Add a node-failure injection experiment (minimum two failure rates) to Section 6.
- [ ] Expand related work to include at least two additional scheduling paradigms (gang scheduling, learned schedulers).
- [ ] Report the hyperparameter search procedure used to obtain $\alpha, \beta, \gamma$.
- [ ] Clarify whether the "resonance" terminology has a literal mathematical grounding or should be renamed for clarity.

> [!note]
> None of the recommended changes are considered fundamentally destabilizing to the paper's core contribution. With moderate revision, this work could be a solid addition to the internal scheduling literature.

---

## 5. Overall Recommendation

Given the promising core idea but significant gaps in reproducibility and evaluation rigor, the consolidated recommendation from all three reviewers is **major revision**. The algorithmic contribution appears novel enough to warrant continued development, but the current draft does not meet the bar for publication or internal deployment without the changes listed above.

A follow-up review is recommended within four weeks of resubmission, ideally accompanied by the requested reference implementation and expanded fault-tolerance experiments.
