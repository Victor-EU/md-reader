# Project Chimera: Q3 Status Report

**Project Lead:** Dr. Elena Vasquez
**Report Date:** October 14, 2024
**Reporting Period:** July 1 – September 30, 2024
**Status:** 🟡 On Track (Minor Delays)

---

## Executive Summary

Project Chimera, our initiative to build a real-time anomaly detection system for distributed sensor networks, has completed its third quarter of development. The team has made substantial progress on the core inference engine and has begun integration testing with our partner facility in Boulder, Colorado. While we remain broadly on schedule, we encountered unexpected latency issues in the edge-computing layer that pushed our beta launch back by approximately three weeks.

Overall, the quarter can be summarized as productive but not without friction. As our senior engineer Marcus Chen put it during last week's retrospective:

> "We built something that works beautifully in the lab and then watched it stumble the moment we introduced real network jitter. That's not a failure — that's exactly why we test."

This report details our technical progress, key performance metrics, outstanding risks, and plans for Q4.

---

## Technical Overview

The core of Project Chimera is a hybrid detection system combining a lightweight statistical filter with a deep learning classifier. The statistical filter operates on each sensor node and flags candidate anomalies using a rolling z-score computed over a sliding window of $n = 128$ samples. Candidates are then forwarded to a central classifier hosted on our regional edge server.

The anomaly score for a given sensor reading $x_t$ at time $t$ is computed as:

$$
S(x_t) = \alpha \cdot \left| \frac{x_t - \mu_w}{\sigma_w + \epsilon} \right| + (1 - \alpha) \cdot f_\theta(x_t, x_{t-1}, \dots, x_{t-k})
$$

where $\mu_w$ and $\sigma_w$ are the mean and standard deviation over the local window $w$, $\epsilon$ is a small stabilizing constant (currently set to $10^{-6}$), $\alpha$ is a blending coefficient tuned to $0.35$ based on our validation sweep, and $f_\theta$ is the output of our trained neural classifier over the trailing $k = 16$ readings.

This formulation lets us balance fast, cheap statistical detection against the more expensive but more accurate neural inference, which only needs to run when the statistical component flags a candidate above threshold $\tau = 0.62$.

### Architecture Changes This Quarter

We migrated the inference pipeline from a monolithic service to a queue-based microservice architecture. This was driven by scaling concerns — our original design could not comfortably handle more than 40 concurrent sensor streams without significant latency spikes. The new architecture, built around a message broker, has already demonstrated improved throughput in staging.

A simplified version of our new ingestion handler is shown below:

```python
import asyncio
from dataclasses import dataclass
from typing import Optional

@dataclass
class SensorReading:
    sensor_id: str
    timestamp: float
    value: float

class IngestionHandler:
    def __init__(self, broker_client, window_size: int = 128):
        self.broker = broker_client
        self.window_size = window_size
        self.buffers: dict[str, list[SensorReading]] = {}

    async def handle_reading(self, reading: SensorReading) -> Optional[float]:
        buf = self.buffers.setdefault(reading.sensor_id, [])
        buf.append(reading)
        if len(buf) > self.window_size:
            buf.pop(0)

        if len(buf) < self.window_size:
            return None  # not enough data yet

        score = self._compute_score(buf)
        if score > 0.62:
            await self.broker.publish("anomaly.candidate", {
                "sensor_id": reading.sensor_id,
                "score": score,
                "timestamp": reading.timestamp,
            })
        return score

    def _compute_score(self, buf: list[SensorReading]) -> float:
        values = [r.value for r in buf]
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        std = variance ** 0.5
        latest = values[-1]
        return abs((latest - mean) / (std + 1e-6))
```

This handler currently processes each incoming reading in under 4 milliseconds on our test hardware, well within our target budget of 10 ms per reading.

---

## Metrics Summary

Below is a snapshot of the key performance indicators we've been tracking throughout Q3.

| Metric | Q2 Baseline | Q3 Target | Q3 Actual | Status |
|---|---|---|---|---|
| Mean detection latency (ms) | 142 | 80 | 91 | 🟡 Close |
| False positive rate (%) | 6.8 | 3.0 | 3.4 | 🟡 Close |
| False negative rate (%) | 2.1 | 1.0 | 0.9 | 🟢 Met |
| Throughput (readings/sec) | 3,200 | 6,000 | 6,850 | 🟢 Exceeded |
| System uptime (%) | 98.2 | 99.5 | 99.1 | 🟡 Close |
| Model retraining cycle (hrs) | 18 | 10 | 11.5 | 🟡 Close |
| Edge node battery life (days) | 21 | 30 | 33 | 🟢 Exceeded |

Our throughput and battery life numbers exceeded expectations, largely thanks to the new microservice architecture and a firmware optimization pass performed by our hardware team in August. However, uptime and detection latency remain slightly below target, primarily due to intermittent network partitioning events at the Boulder test site.

### Detection Accuracy Breakdown

We also tracked model performance across different anomaly categories during our September validation run:

| Anomaly Type | Precision | Recall | F1 Score |
|---|---|---|---|
| Sudden spike | 0.94 | 0.91 | 0.92 |
| Slow drift | 0.81 | 0.77 | 0.79 |
| Sensor dropout | 0.97 | 0.95 | 0.96 |
| Correlated multi-node failure | 0.72 | 0.68 | 0.70 |

The "slow drift" and "correlated multi-node failure" categories remain our weakest areas. We suspect the drift category suffers because our window size of 128 samples may be too short to capture gradual trends — we're experimenting with a secondary long-window filter to address this in Q4.

---

## Risks and Issues

> [!warning]
> The Boulder test site has experienced three network partition events since August 1st, each lasting between 4 and 11 minutes. During these events, edge nodes fall back to local buffering, but any anomaly detected during a partition is delayed until connectivity resumes. This is an acceptable short-term mitigation but is **not** a viable long-term solution if we scale to sites with less reliable connectivity than Boulder's fiber backbone.

We are currently evaluating two potential fixes: (1) deploying a lightweight local classifier that can operate fully offline during partitions, and (2) negotiating a secondary network provider contract for redundancy at high-value sites. Cost estimates for option 2 are still being gathered from procurement.

> [!note]
> Our data science team, led by Priya Nair, has flagged that the training dataset for the "correlated multi-node failure" category is significantly smaller than the others (only 340 labeled examples versus 2,000+ for other categories). This imbalance is likely contributing to the lower F1 score in that category. A synthetic data augmentation effort is planned for early Q4.

Additional risks worth noting:

- **Vendor dependency risk:** Our current message broker vendor, Relayforge, announced a pricing restructuring that could increase our infrastructure costs by an estimated 18% starting January 2025. We are evaluating self-hosted alternatives.
- **Staffing risk:** One of our two ML engineers, Sam Okafor, will be transitioning to a different team in November. We are actively recruiting a replacement but expect a short capacity gap.
- **Regulatory risk:** New data residency requirements in the EU may affect our plans to expand the pilot to our Munich facility next year. Legal review is in progress.

---

## What Went Well

The migration to the queue-based architecture was, on the whole, a success story for the quarter. The team completed the migration two days ahead of the internal deadline, and load testing showed the system handling up to 9,000 simulated readings per second before showing any signs of degradation — well above our stated target.

Collaboration with the hardware team also improved significantly this quarter. Weekly sync meetings between the firmware and software groups, introduced in July, appear to have reduced integration bugs by a noticeable margin; we counted only 4 integration-related bugs in Q3 compared to 17 in Q2.

We also want to highlight the effort put into documentation this quarter. The internal wiki now includes a full architecture decision record (ADR) log, which several new team members have cited as extremely helpful during onboarding.

---

## What Didn't Go Well

The detection latency numbers, while close to target, mask a more concerning tail-latency problem. While our median latency sits comfortably at 91 ms, our p99 latency spikes to nearly 410 ms during periods of high sensor load. This tail behavior is not yet well understood and will require dedicated profiling time in Q4.

We also underestimated the complexity of retraining our neural classifier on the expanded dataset. What was budgeted as a two-week task ended up taking closer to five weeks, primarily due to unexpected instability during training — loss curves would occasionally spike sharply around epoch 40 before recovering, a phenomenon we're still investigating. Our current hypothesis involves interaction effects between our learning rate schedule and a recently introduced batch normalization layer, but this remains unconfirmed.

---

## Task List for Q4

Below is our prioritized task list heading into the fourth quarter. Items already completed are checked.

- [x] Complete migration to queue-based microservice architecture
- [x] Finalize firmware optimization for edge battery life
- [x] Establish weekly hardware/software sync meetings
- [x] Draft architecture decision record (ADR) documentation
- [ ] Investigate and resolve p99 latency spikes in detection pipeline
- [ ] Deploy synthetic data augmentation for correlated multi-node failure category
- [ ] Evaluate offline/local classifier fallback for network partition events
- [ ] Complete cost analysis for secondary network provider at Boulder site
- [ ] Finish recruiting replacement for departing ML engineer
- [ ] Investigate training instability around epoch 40 in classifier retraining
- [ ] Begin legal review of EU data residency requirements for Munich expansion
- [ ] Conduct full security audit of message broker integration

---

## Next Steps

Our immediate focus for the first half of Q4 will be stabilizing the tail-latency behavior in the detection pipeline, as this has the most direct impact on our ability to meet SLA commitments with pilot partners. We plan to bring in an outside consultant with distributed systems profiling experience to assist, given
