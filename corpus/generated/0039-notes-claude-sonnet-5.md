# Research Notes: Streaming Quantile Estimation — A Comparison of Three Sketch Families

## Context

While profiling latency telemetry for the fictional **Corvane** ingestion pipeline, I needed a memory-bounded way to estimate quantiles (p50, p90, p99) over an unbounded stream of floating-point measurements. Three candidate sketch designs were evaluated: the **Talvos Sketch**, the **Renbrik Digest**, and the **Ostrale Histogram**. These notes summarize the tradeoffs.

---

## 1. Talvos Sketch

The Talvos Sketch buckets incoming values into $\log_2$-scaled bins and maintains a compressed count per bin using a biased merging rule. Its headline claim is a relative error bound of $\varepsilon = 0.01$ for any quantile $\phi \in (0,1)$, using $O(\frac{1}{\varepsilon}\log(\varepsilon n))$ space.

Key properties:

- Deterministic error bounds, no randomness involved
- Merge-friendly: two sketches from different shards can be combined in $O(k)$ time where $k$ is the bucket count
- Slightly worse accuracy near the extreme tails (p999+) because bin width grows geometrically

> [!note]
> In practice, the Talvos Sketch performed within 0.4% of the true p99 on a synthetic dataset of 12 million samples, but drifted to 2.1% error at p999.9 due to coarse binning near the tail.

A minimal reference implementation of the merge step:

```python
def merge_talvos(sketch_a, sketch_b):
    """Merge two Talvos sketches bucket-wise."""
    merged = {}
    for bucket in set(sketch_a) | set(sketch_b):
        merged[bucket] = sketch_a.get(bucket, 0) + sketch_b.get(bucket, 0)
    return merged
```

---

## 2. Renbrik Digest

The Renbrik Digest takes a different tack: it clusters points using variable-size centroids, where centroid size is inversely proportional to local density near the tails. This gives much tighter tail accuracy at the cost of a more complex merge operation.

The core invariant guarantees that for a centroid $c_i$ with weight $w_i$, the cumulative weight satisfies

$$
q(c_i) = \frac{1}{n}\sum_{j < i} w_j + \frac{w_i}{2n}
$$

and the maximum centroid size is bounded by a scale function $k(q)$ such that $k(q) \propto \sin^{-1}(2q-1)$, concentrating small centroids near $q \approx 0$ and $q \approx 1$.

Nested comparison of implementation concerns:

- Data structure
  - Centroid list (sorted by mean)
    - Balanced tree variant
      - Pro: $O(\log n)$ insertion
      - Con: higher constant factor per insert
    - Flat array variant
      - Pro: cache-friendly scans
      - Con: $O(n)$ worst-case insertion before periodic compression
  - Compression buffer
    - Batched every 5,000 inserts
      - Reduces centroid count from ~4,000 to ~300 typically
- Accuracy profile
  - Median error: negligible ($< 0.05\%$)
  - Tail error (p99.9): typically $< 0.15\%$

> [!warning]
> The Renbrik Digest's compression step is not commutative under concurrent writes. Two threads compressing simultaneously without a lock can produce centroid sets that violate the ordering invariant, silently corrupting quantile queries.

As one engineer summarized during the Corvane postmortem review:

> "We assumed digest merges were associative because the paper said so for the single-threaded case — nobody checked what happens when compression runs mid-merge."

---

## 3. Ostrale Histogram

The Ostrale Histogram is the simplest of the three: a fixed set of $m$ equal-width bins recomputed periodically from a reservoir sample of size $r$. Its error is purely a function of sample size and bin granularity, following the familiar concentration bound

$$
P\left(|\hat{q}_\phi - q_\phi| > \delta\right) \le 2\exp\left(-2r\delta^2\right)
$$

which is easy to reason about but does not exploit any structure of the incoming distribution.

Advantages:

- Trivial to implement and audit
- Very low CPU overhead per insert (amortized $O(1)$)
- Predictable memory footprint: exactly $m + r$ words

Disadvantages:

- No adaptivity to skewed distributions — bimodal latency traffic (a common real pattern, e.g., cache-hit vs cache-miss latencies) produces systematically biased quantile estimates
- Reservoir refresh introduces a periodic accuracy dip immediately after each resampling window

---

## Summary Table (informal)

| Approach | Space | Tail accuracy | Merge complexity | Concurrency safety |
|---|---|---|---|---|
| Talvos Sketch | $O(\varepsilon^{-1}\log n)$ | moderate | low | high |
| Renbrik Digest | $O(k(q))$ variable | high | moderate | low (needs locking) |
| Ostrale Histogram | $O(m+r)$ fixed | low–moderate | trivial | high |

## Tentative Recommendation

For Corvane's multi-shard aggregation use case, the Talvos Sketch appears to offer the best balance: bounded, predictable error with cheap, lock-free merging. The Renbrik Digest's superior tail accuracy is tempting for SLO-sensitive p999 alerts, but the concurrency caveat above needs a proper mutex or copy-on-write scheme before it can be trusted in production. The Ostrale Histogram remains useful only as a cheap sanity-check baseline, not a primary estimator.
