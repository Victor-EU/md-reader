# Research Notes: Approximate Nearest Neighbor Search Strategies

**Author:** M. Okonkwo-Reyes
**Date:** internal draft, project *Harborlight*
**Scope:** comparing three ANN indexing strategies for embedding retrieval at ~40M vectors, 768 dimensions.

---

## 1. Background

We need sub-50ms p99 retrieval latency over a growing embedding store. Three candidate approaches were prototyped: **IVF-PQ** (inverted file with product quantization), **HNSW** (hierarchical navigable small world graphs), and **ScaNN-style anisotropic quantization**. This note summarizes tradeoffs observed during benchmarking on the `vault-9` cluster.

The recall target is defined as $R@10 \geq 0.92$ against exact brute-force search, with a latency budget $\ell \leq 50\text{ms}$ at $p_{99}$.

## 2. Cost Model

For a query vector $q$ and index of size $n$, the expected search cost under IVF-based methods approximates:

$$
C(q) \approx n_{\text{probe}} \cdot \frac{n}{k_{\text{lists}}} \cdot d + n_{\text{probe}} \cdot k_{\text{lists}}
$$

where $d$ is embedding dimensionality, $k_{\text{lists}}$ the number of coarse clusters, and $n_{\text{probe}}$ the probe count. Increasing $n_{\text{probe}}$ raises recall but linearly increases scan cost.

> [!note]
> HNSW's cost does not decompose this cleanly — it's closer to $O(\log n)$ hops per query, each with bounded fan-out $M$, but variance across queries is higher due to graph entry-point sensitivity.

## 3. Benchmark Setup

```python
def build_index(vectors, method="hnsw", **kwargs):
    if method == "ivf_pq":
        return IVFPQIndex(nlist=kwargs["nlist"], m=kwargs["subquantizers"])
    elif method == "hnsw":
        return HNSWIndex(M=kwargs["M"], ef_construction=kwargs["ef"])
    elif method == "scann":
        return ScannIndex(anisotropic_weight=kwargs["aw"])
    raise ValueError(f"unknown method: {method}")
```

## 4. Results Summary

1. **IVF-PQ** — lowest memory footprint (≈9 bytes/vector), moderate recall (0.89 at 50ms), best for memory-constrained shards.
2. **HNSW** — highest recall (0.94) but memory cost ~4x larger; build time also significantly longer.
3. **ScaNN-anisotropic** — best latency/recall tradeoff overall, though tuning `anisotropic_weight` is finicky.

### Nested detail on tuning

- IVF-PQ
    - Cluster count
        - 4096 clusters: recall 0.87
        - 8192 clusters: recall 0.90
            - diminishing returns beyond this
    - Subquantizer count
        - 16 subquantizers: fast but lossy
        - 32 subquantizers: better fidelity, 2x memory
- HNSW
    - `M` parameter
        - M=16: baseline
        - M=32: +6% recall, +40% memory
- ScaNN
    - anisotropic weight sweep
        - 0.2 → underweights parallel error
        - 0.5 → balanced, chosen default

> [!warning]
> HNSW build times exceeded 6 hours on the full 40M corpus without careful `ef_construction` tuning — do not run full rebuilds on the shared cluster during business hours.

## 5. Open Tasks

- [x] Benchmark IVF-PQ with 8192 clusters
- [x] Benchmark HNSW with M=16 and M=32
- [ ] Benchmark ScaNN with weight sweep 0.1–0.9
- [ ] Profile memory under concurrent shard rebuilds
- [ ] Draft migration plan from current flat index

---

## 6. Preliminary Recommendation

Given latency/recall balance, ScaNN-style anisotropic quantization is the leading candidate, with HNSW as fallback for shards where memory is not a constraint. Final decision pending the weight-sweep results.
