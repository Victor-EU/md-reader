# Research Notes: Approaches to Approximate Nearest-Neighbor Retrieval

**Author:** internal notes, project *Halcyon-9*
**Date:** working draft

## 1. Problem Framing

We are evaluating strategies for retrieving the top-$k$ nearest vectors from a corpus of roughly 40 million embeddings, each of dimension $d = 768$. The baseline exhaustive search costs $O(n d)$ per query, which is untenable at our target latency budget of 15ms. Three candidate families were prototyped: **tree-partitioning (KD-Forest)**, **graph-based navigation (HNSW-Lite)**, and **quantization with inverted lists (IVF-PQ)**.

The core trade-off is between recall $R$, query latency $t_q$, and index build time $t_b$. We define effective quality as

$$
Q = \frac{R^{2}}{\log(1 + t_q)}
$$

which penalizes latency logarithmically while rewarding recall quadratically, reflecting our product requirement that recall dominate below a 20ms ceiling.

## 2. KD-Forest

KD-Forest builds an ensemble of $m$ randomized KD-trees, each splitting on a randomly chosen high-variance dimension. Query time scales roughly as $O(m \log n)$ when backtracking is bounded by a priority queue of size $L$.

- [x] Implemented baseline single-tree KD search
- [x] Extended to forest of $m = 12$ trees with shared leaf cache
- [ ] Tune backtracking budget $L$ against recall curve
- [ ] Profile memory footprint at $n = 40M$

In practice, recall plateaus around $R \approx 0.81$ even with generous backtracking, because axis-aligned splits degrade badly once $d$ exceeds roughly 100. This matches the intuition that KD-trees lose discriminative power as the curse of dimensionality erodes split quality.

> [!warning]
> KD-Forest memory usage grows linearly with $m$, and at $m = 12$ trees the index exceeded 38 GB in our staging cluster — nearly triple the raw embedding size. This may be disqualifying for cost-constrained deployments.

## 3. HNSW-Lite

HNSW-Lite constructs a multi-layer proximity graph where each node maintains $M$ bidirectional edges per layer. Search descends from a sparse top layer to a dense bottom layer, following greedy best-first traversal with a candidate list of size $\text{ef}$.

```python
def search_hnsw(graph, query, ef=64, entry=0):
    visited = {entry}
    candidates = [(distance(query, entry), entry)]
    best = list(candidates)
    while candidates:
        dist, node = pop_closest(candidates)
        if dist > worst(best) and len(best) >= ef:
            break
        for neighbor in graph.neighbors(node):
            if neighbor not in visited:
                visited.add(neighbor)
                d = distance(query, neighbor)
                if d < worst(best) or len(best) < ef:
                    push(candidates, (d, neighbor))
                    push(best, (d, neighbor))
    return top_k(best, k=10)
```

This approach achieved the highest recall in our trials, around $R \approx 0.97$ at $\text{ef} = 64$, with median latency near 6ms. The cost is build time: constructing the graph for 40M vectors took approximately 9.5 hours on a 32-core machine, compared to under 2 hours for KD-Forest.

- [x] Build graph on 2M-vector subsample
- [x] Validate recall against brute-force ground truth
- [x] Benchmark full 40M-vector build
- [ ] Investigate incremental insertion without full rebuild

## 4. IVF-PQ

Inverted-File Product Quantization first clusters the corpus into $C$ coarse cells via k-means, then compresses residuals within each cell using product quantization with $s$ subquantizers. Query cost is approximately

$$
t_q \propto \frac{n}{C}\cdot s + C
$$

since a query only probes a small number of nearby cells (we used $n_\text{probe} = 8$) rather than scanning the full corpus.

IVF-PQ offered the smallest memory footprint by far — around 6 GB for the full corpus, an order of magnitude below both alternatives — because each vector is stored as an 8-byte quantized code rather than as a full 768-dimensional float array. Recall was moderate, $R \approx 0.89$, and highly sensitive to the choice of $C$ and $n_\text{probe}$.

> [!note]
> Increasing $n_\text{probe}$ from 8 to 24 raised recall to roughly 0.93 but tripled latency to 14ms, right at our budget ceiling. This tuning knob is the main lever for this approach and deserves a dedicated sweep before any production decision.

## 5. Comparative Summary

| Approach | Recall $R$ | Latency $t_q$ | Build time $t_b$ | Memory |
|---|---|---|---|---|
| KD-Forest | 0.81 | 11ms | 1.8h | 38 GB |
| HNSW-Lite | 0.97 | 6ms | 9.5h | 22 GB |
| IVF-PQ | 0.89 | 9ms | 3.2h | 6 GB |

Using the quality metric $Q$ defined above, HNSW-Lite scores highest ($Q \approx 0.51$), followed by IVF-PQ ($Q \approx 0.36$) and KD-Forest ($Q \approx 0.28$). Given our latency ceiling and acceptable build-time window (overnight batch jobs), HNSW-Lite is the current front-runner, with IVF-PQ retained as a fallback for memory-constrained edge deployments.

## 6. Open Questions

- [ ] Can HNSW-Lite build time be reduced via parallel layer construction?
- [ ] Is a hybrid IVF + graph refinement stage worth prototyping?
- [x] Confirm ground-truth recall measurement methodology is consistent across all three benchmarks
