# Research Notes: Comparing Approaches to Real-Time Anomaly Detection in Streaming Sensor Data

**Author:** M. Ostrander
**Project:** Project Halcyon — Adaptive Telemetry Pipeline
**Date:** internal draft, revision 4

## 1. Background

Our fleet of *industrial vibration sensors* (call sign: **Node-7 array**) streams roughly 12,000 samples per second per unit. The central question for this quarter's sprint is: which anomaly-detection strategy gives us the best trade-off between latency, memory footprint, and detection accuracy when deployed on edge devices with only 256 MB of RAM?

Three candidate approaches were evaluated over a six-week bake-off:

1. **Statistical Thresholding (ST)** — a rolling z-score method with adaptive window sizing.
2. **Lightweight Autoencoder (LAE)** — a compact neural network trained to reconstruct normal signal windows.
3. **Sketch-Based Sequential Testing (SBST)** — a probabilistic data-sketch combined with sequential hypothesis testing.

> [!note]
> All experiments were run against the synthetic **Kessler-9** dataset, a simulated corpus of 4.3 million sensor windows generated to mimic bearing degradation patterns in rotating machinery. No production data was used in this phase.

---

## 2. Method Summaries

### 2.1 Statistical Thresholding (ST)

ST maintains a rolling mean $\mu_t$ and standard deviation $\sigma_t$ over a sliding window of length $w$. For each new sample $x_t$, the anomaly score is computed as:

$$
z_t = \frac{x_t - \mu_{t-1}}{\sigma_{t-1} + \epsilon}
$$

where $\epsilon$ is a small constant (we used $\epsilon = 10^{-6}$) to avoid division-by-zero when the signal is nearly constant. A sample is flagged when $|z_t| > \tau$, with $\tau$ typically set between 2.5 and 3.5.

The *appeal* of ST is its simplicity: $O(1)$ update cost per sample and negligible memory beyond the window buffer. Its **weakness** is sensitivity to slow drift — if the underlying process mean shifts gradually, ST can silently "absorb" an emerging fault into its baseline.

### 2.2 Lightweight Autoencoder (LAE)

The LAE approach trains a small feed-forward network (two hidden layers, 32 and 16 units respectively) to reconstruct 64-sample windows of normal operation. The reconstruction error

$$
e_t = \| x_{t-63:t} - \hat{x}_{t-63:t} \|_2^2
$$

serves as the anomaly signal. Windows with $e_t$ exceeding a learned percentile threshold (typically the 99.2nd percentile of validation error) are flagged.

This method captures **nonlinear** relationships among features that ST cannot, but requires periodic retraining and a non-trivial inference cost on constrained hardware.

### 2.3 Sketch-Based Sequential Testing (SBST)

SBST maintains a compact *Count-Min-like* sketch of recent value distributions and applies a sequential probability ratio test (SPRT) to decide, sample by sample, whether the observed distribution has diverged from the reference sketch. The decision boundary follows the classical SPRT log-likelihood ratio:

$$
\Lambda_t = \sum_{i=1}^{t} \log \frac{p_1(x_i)}{p_0(x_i)}
$$

An alarm triggers when $\Lambda_t$ crosses an upper bound $\log\left(\frac{1-\beta}{\alpha}\right)$, where $\alpha$ and $\beta$ are the desired false-positive and false-negative rates.

---

## 3. Experimental Setup

We deployed all three methods on an emulated edge node (ARM Cortex-A53, 4 cores, 256 MB RAM) using the Kessler-9 dataset split as follows:

- Training: 60%
- Validation: 20%
- Test (with injected faults): 20%

A minimal harness was used to standardize timing measurements. Below is the core benchmarking loop, written in Python for reproducibility:

```python
import time
import numpy as np

def benchmark(detector, stream, warmup=500):
    latencies = []
    flags = []
    for i, x in enumerate(stream):
        t0 = time.perf_counter()
        flagged = detector.update(x)
        t1 = time.perf_counter()
        if i > warmup:
            latencies.append((t1 - t0) * 1e6)  # microseconds
            flags.append(flagged)
    return {
        "p50_latency_us": np.percentile(latencies, 50),
        "p99_latency_us": np.percentile(latencies, 99),
        "flag_rate": np.mean(flags),
    }
```

Each detector implements an `update(x)` method returning a boolean. We ran 30 independent trials per method to account for scheduling jitter on the emulated hardware.

---

## 4. Results

### 4.1 Latency and Memory

| Approach | p50 Latency (µs) | p99 Latency (µs) | Peak RSS (MB) |
|---|---|---|---|
| ST | 4.2 | 9.8 | 3.1 |
| LAE | 61.7 | 118.4 | 22.6 |
| SBST | 15.3 | 34.9 | 8.9 |

The **ST** method is, unsurprisingly, the fastest and lightest by a wide margin. **LAE** incurs roughly 15× the latency of ST at p50, driven by matrix multiplications during inference. **SBST** sits comfortably in between.

> [!warning]
> The LAE p99 latency exceeded our edge SLA of 100 µs in 3 of 30 trials, all correlated with background garbage-collection pauses in the runtime. This is a deployment risk that needs mitigation before production rollout.

### 4.2 Detection Quality

Detection quality was measured using the F1 score against a held-out set of 1,240 labeled synthetic faults, categorized into three severity tiers.

1. **Tier 1 — Abrupt faults** (sudden amplitude spikes)
   - ST: F1 = 0.91
   - LAE: F1 = 0.88
   - SBST: F1 = 0.93
2. **Tier 2 — Gradual drift faults** (slow degradation over 40+ minutes)
   - ST: F1 = 0.54
   - LAE: F1 = 0.79
   - SBST: F1 = 0.85
3. **Tier 3 — Intermittent faults** (brief, recurring anomalies)
   - ST: F1 = 0.68
   - LAE: F1 = 0.71
   - SBST: F1 = 0.77

The pattern is clear: ST performs *acceptably* on abrupt faults but degrades sharply on gradual drift, exactly as predicted in Section 2.1. Both LAE and SBST handle drift far better, with **SBST achieving the best overall balance** across all tiers.

---

## 5. Qualitative Observations

Nested breakdown of implementation concerns discovered during the bake-off:

- **Statistical Thresholding**
  - Configuration surface
    - Window size $w$
      - Small $w$ (e.g., 50): reacts fast, noisy
      - Large $w$ (e.g., 2000): smooth, but slow to adapt
        - Requires manual retuning per sensor class
  - Failure modes
    - Baseline drift absorption
    - Threshold miscalibration after sensor recalibration events
- **Lightweight Autoencoder**
  - Configuration surface
    - Hidden layer sizes
      - Larger networks (64+16) improved Tier 2 F1 by ~3% but doubled latency
    - Training cadence
      - Weekly retraining recommended
        - Requires a labeled-normal buffer of at least 10,000 windows
  - Failure modes
    - Model staleness after mechanical wear patterns shift
    - Cold-start inference spikes after retraining deployment
- **Sketch-Based Sequential Testing**
  - Configuration surface
    - Sketch width and depth
      - Wider sketches reduce collision-induced false positives
        - At the cost of memory (~1 KB per 128 buckets)
    - SPRT boundaries $\alpha, \beta$
  - Failure modes
    - Sketch saturation under highly bursty traffic
    - Requires periodic sketch decay to avoid stale reference distributions

---

## 6. Task Tracking

Outstanding engineering tasks before the next review:

- [x] Implement ST baseline with adaptive window resizing
- [x] Train LAE model v1 on Kessler-9 training split
- [x] Benchmark latency across all three methods on emulated hardware
- [ ] Investigate LAE p99 latency spikes and GC pause mitigation
- [x] Implement SBST sketch decay mechanism
- [ ] Run cross-validation on a second synthetic dataset (**Kessler-10**, still in generation)
- [ ] Draft cost model for production memory budget across 400 fleet nodes
- [ ] Present findings to the *Telemetry Working Group* on the 14th

---

## 7. Discussion

The bake-off suggests no single method dominates across all axes. If the deployment constraint were purely about **resource frugality**, ST remains attractive — its simplicity is genuinely valuable for a fleet of thousands of low-power nodes. However, its blindness to gradual drift is a serious limitation for our primary use case: early detection of bearing wear, which is *inherently* a slow-onset phenomenon.

LAE offers the strongest raw detection capability on nonlinear fault signatures but its latency profile and retraining overhead make it a harder sell for edge deployment without further optimization (e.g., quantization, pruning).

SBST emerges as the ==most balanced candidate== for our specific constraints: acceptable latency, modest memory footprint, and the best aggregate F1 across fault tiers. It is not without complexity cost, however — tuning $\alpha$, $\beta$, and sketch dimensions requires more operational expertise than the other two methods.

As one reviewer noted during the internal design review:

> "The value of a monitoring system is not merely in how rarely it misses a fault, but in how gracefully it degrades when it does. SBST's sequential structure gives us a natural confidence signal that the other two approaches lack."

This point resonates with our broader philosophy for Project Halcyon: we would rather have a detector that communicates *uncertainty* than one that produces brittle, overconfident binary flags.

---

## 8. Recommendation

Based on the aggregate evidence, the recommendation for the next deployment phase is:

1. Adopt **SBST** as the primary detector for production nodes handling gradual-drift-sensitive equipment.
2. Retain **ST** as a fallback/lightweight secondary check for nodes with severe memory constraints (< 4 MB budget).
3. Continue LAE research as a **future-phase** enhancement,
