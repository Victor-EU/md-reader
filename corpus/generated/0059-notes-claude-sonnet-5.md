# Research Notes: Streaming Top-K Frequency Estimation

## Problem Statement

We need to identify the *most frequent items* in a high-velocity data stream using **sub-linear memory**. Three candidate approaches were evaluated: **Count-Min Sketch (CMS)**, **Space-Saving (SS)**, and a hybrid **Reservoir-Weighted Sketch (RWS)** designed internally by the Vantar Systems team.

---

## 1. Count-Min Sketch

CMS maintains a $d \times w$ array of counters, updated via $d$ independent hash functions $h_1, \dots, h_d$. For an item $x$, the estimated count is:

$$
\hat{f}(x) = \min_{i=1}^{d} C[i, h_i(x)]
$$

The error bound is characterized by $\varepsilon$ and $\delta$, where memory usage scales as $O\left(\frac{1}{\varepsilon}\log\frac{1}{\delta}\right)$.

> [!note]
> CMS never *underestimates* true counts, but collisions can inflate estimates, especially under skewed (Zipfian) distributions.

**Pros:** simple, parallelizable, well-studied.
**Cons:** overestimation bias grows with hash collisions.

## 2. Space-Saving

Space-Saving tracks a fixed-size list of $k$ candidate items with associated counters and error terms $\varepsilon_i$. When a new unseen item arrives and the table is full, the item with the smallest counter is evicted and replaced.

```python
def space_saving_update(counters, item, k):
    if item in counters:
        counters[item] += 1
    elif len(counters) < k:
        counters[item] = 1
    else:
        victim = min(counters, key=counters.get)
        counters[item] = counters.pop(victim) + 1
    return counters
```

Space-Saving guarantees that the true rank of any reported top-$k$ item is bounded, making it attractive for *exact-ish* heavy hitter detection.

## 3. Reservoir-Weighted Sketch (RWS)

RWS combines a decayed reservoir sample with a lightweight counter array. Each item's weight decays over time according to $w(t) = w_0 \cdot e^{-\lambda t}$, letting the structure adapt to concept drift.

Evaluation criteria, in order of priority:

1. **Accuracy** under skewed distributions
2. **Memory footprint** at fixed error tolerance
3. **Update latency** per stream event
4. **Adaptivity** to non-stationary streams

### Detailed Comparison

- **Count-Min Sketch**
    - Strengths
        - Trivial to merge across shards
        - No dependency on item ordering
    - Weaknesses
        - Sensitive to hash collisions
            - Worsens sharply for $d < 4$
            - Mitigated partially by conservative updates
- **Space-Saving**
    - Strengths
        - Tight theoretical guarantees
        - Deterministic eviction policy
    - Weaknesses
        - Costly under extremely bursty traffic
- **Reservoir-Weighted Sketch**
    - Strengths
        - Handles ==non-stationary streams== gracefully
        - Tunable decay rate $\lambda$
    - Weaknesses
        - Less mature theoretical analysis

> [!warning]
> RWS has not been validated at throughput above **2.4 million events/sec** in our internal benchmarks; results beyond that regime are speculative.

---

## Preliminary Recommendation

For workloads with strong temporal drift, RWS appears *most promising*, though its lack of formal error bounds is a real concern for production deployment. Space-Saving remains the safest default when strict rank guarantees are required, while CMS is best suited to distributed aggregation scenarios where mergeability outweighs precision.

Further experiments should measure $\Pr[|\hat{f}(x) - f(x)| > \varepsilon N]$ across all three structures using the **Halvorsen-9 synthetic stream generator** before any final architectural decision is made.
