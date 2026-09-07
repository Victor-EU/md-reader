# Project Nightingale: Predictive Maintenance Platform

## Project Overview

**Project Nightingale** is an initiative by **Solandra Industrial Systems** to build a predictive maintenance platform for its fleet of 214 industrial compressors deployed across 12 regional plants. The platform will use sensor telemetry and machine learning to forecast equipment failure *before* it happens, reducing unplanned downtime and extending asset lifespan.

The project sponsor is **Priya Nandakumar**, VP of Operations, and the executive stakeholder is **Marcus Feld**, CTO. The core delivery team is drawn from the **Applied Analytics Guild**, a cross-functional group of data scientists, engineers, and reliability specialists.

> "We don't need a system that tells us a machine failed. We need one that tells us it's *about* to."
> — Priya Nandakumar, Kickoff Address, March 2024

---

## Objectives

- Reduce unplanned compressor downtime by **35%** within 12 months of full deployment.
- Achieve a false-positive alert rate below 8%.
- Establish a reusable telemetry pipeline for future asset classes (pumps, turbines, chillers).
- Deliver a self-service dashboard for plant reliability engineers.

> [!note]
> This plan assumes existing SCADA infrastructure at all 12 plants is compatible with the new edge-gateway hardware. A compatibility audit is scheduled in Phase 1 to validate this assumption.

---

## Phase 1: Discovery & Data Foundations

**Duration:** 8 weeks
**Owner:** *Renata Oyelaran*, Lead Data Engineer

### Goals

The discovery phase establishes ground truth about the current state of sensor coverage, historical failure records, and data quality. Without this foundation, downstream modeling work in Phase 3 would be built on sand.

### Key Activities

1. Inventory existing sensors across all 214 compressors
   - Vibration sensors (accelerometers)
     - Confirm sampling rate ≥ 2 kHz
     - Confirm calibration date within last 18 months
   - Temperature probes
   - Pressure transducers
2. Audit historical maintenance logs (2019–2024)
3. Interview reliability engineers at 4 pilot plants
4. Draft a data governance charter with **Legal & Compliance**

### Milestones

| Milestone | Target Date | Owner |
|---|---|---|
| Sensor inventory complete | Week 3 | Renata Oyelaran |
| Historical data extract validated | Week 5 | Tomasz Wieczorek |
| Governance charter signed off | Week 8 | Priya Nandakumar |

### Tasks

- [x] Confirm plant list and compressor asset IDs
- [x] Set up secure data lake staging environment
- [ ] Complete calibration audit for vibration sensors
- [ ] Finalize data-sharing agreement with plant IT teams
- [ ] Publish discovery findings report

### Risks

- **Data sparsity risk**: Some older compressors (pre-2016 models) may lack sufficient sensor coverage, limiting model training data. *Mitigation*: prioritize retrofit budget for the 22 oldest units.
- **Stakeholder fatigue**: Reliability engineers at pilot plants have limited bandwidth for interviews. *Mitigation*: cap interviews at 45 minutes, offer async written surveys as an alternative.

---

## Phase 2: Platform Architecture

**Duration:** 10 weeks
**Owner:** *Julian Castellane*, Principal Systems Architect

### Goals

Design a scalable ingestion-to-inference architecture that can handle telemetry from all 12 plants simultaneously, with room to onboard three additional asset classes by 2026.

### Architecture Summary

The pipeline follows a standard streaming architecture: edge gateways buffer and forward sensor readings to a regional message broker, which feeds both a real-time anomaly scorer and a batch data warehouse for model retraining.

```yaml
pipeline:
  ingestion:
    protocol: MQTT
    broker: regional-kafka-cluster
    batch_interval_seconds: 15
  processing:
    stream_engine: flink
    anomaly_scorer: onnx-runtime
  storage:
    hot_tier: timescaledb
    cold_tier: parquet-on-s3
  serving:
    api: fastapi
    dashboard: react-dash
```

### Key Decisions

- **Edge vs. cloud inference**: Given plant network latency averages ~140 ms, we will run a lightweight anomaly scorer *at the edge* and reserve full model inference for the cloud tier.
- **Message broker choice**: Kafka was selected over RabbitMQ for its superior throughput under burst conditions (compressor startup events generate spikes of ~4,000 messages/sec).

### Milestones

- [x] Architecture decision record (ADR) drafted
- [x] Security review with InfoSec team completed
- [ ] Reference architecture approved by Marcus Feld
- [ ] Edge gateway hardware procurement finalized

### Risks

> [!warning]
> The chosen edge-gateway vendor, **Korvex Systems**, has a historical average lead time of 11 weeks for bulk orders. Any delay in procurement approval directly threatens the Phase 3 start date.

Additional risks:
- **Vendor lock-in**: Heavy reliance on Kafka-managed services could complicate future migration.
- **Network reliability**: Two plants (Denholt and Ashcombe) have reported intermittent WAN outages exceeding 30 minutes/month.

---

## Phase 3: Model Development

**Duration:** 12 weeks
**Owner:** *Dr. Amara Solheim*, Head of Data Science

### Goals

Build and validate predictive models capable of forecasting compressor bearing failure and seal degradation with sufficient lead time (target: **72 hours** advance warning) for maintenance crews to schedule intervention.

### Modeling Approach

We frame failure prediction as a survival analysis problem. Let $T$ denote the time to failure for a given compressor unit, and let $x_i$ represent the feature vector of sensor readings at time $i$. The hazard function is modeled as:

$$
h(t \mid x) = h_0(t) \cdot \exp\left(\beta_1 x_1 + \beta_2 x_2 + \cdots + \beta_k x_k\right)
$$

where $h_0(t)$ is the baseline hazard and $\beta_k$ are learned feature weights. Feature engineering includes rolling statistics such as the vibration RMS over a 10-minute window, denoted $x_{\text{rms}} = \sqrt{\frac{1}{n}\sum_{i=1}^n v_i^2}$.

### Key Activities

1. Feature engineering pipeline
   - Rolling window statistics (RMS, kurtosis, skewness)
     - 10-minute window
     - 60-minute window
       - Cross-validated against known failure events from Phase 1 logs
   - Frequency-domain features (FFT peak detection)
2. Baseline model training (Cox proportional hazards, gradient-boosted survival trees)
3. **Model evaluation** against held-out failure events from 2023
4. Bias and fairness review — ensuring the model does not systematically underperform on older compressor models

### Milestones

| Milestone | Target Date | Owner |
|---|---|---|
| Feature pipeline v1 complete | Week 4 | Tomasz Wieczorek |
| Baseline model trained | Week 7 | Amara Solheim |
| Model achieves ≥ 80% recall at 72-hr horizon | Week 10 | Amara Solheim |
| Final model card published | Week 12 | Amara Solheim |

### Tasks

- [x] Establish train/validation/test split by plant, not by time, to avoid leakage
- [x] Build baseline logistic regression benchmark
- [ ] Tune gradient-boosted survival model hyperparameters
- [ ] Complete fairness audit across compressor age cohorts
- [ ] Document model limitations in model card

### Risks

- **Class imbalance**: Failures are rare events (~1.8% of unit-months), which can bias models toward predicting "no failure." *Mitigation*: use focal loss and synthetic oversampling of failure windows.
- **Overfitting to pilot plants**: Since only 4 plants have rich historical labels, models may not generalize to the remaining 8. *Mitigation*: hold out one pilot plant entirely for final validation.
- ==Critical risk==: If recall at the 72-hour horizon falls below 65%, the maintenance lead time will be operationally useless, and the project's core value proposition collapses.

---

## Phase 4: Pilot Deployment

**Duration:** 6 weeks
**Owner:** *Renata Oyelaran* (Data Engineering) & *Dr. Amara Solheim* (Model Ops)

### Goals

Deploy the full pipeline — edge ingestion, streaming inference, and dashboard alerts — to the four pilot plants: **Brackwater**, **Denholt**, **Sundale**, and **Ashcombe**.

### Key Activities

1. Install edge gateways at pilot sites
2. Shadow-mode deployment (model runs but does not trigger maintenance tickets)
3. Compare model alerts against actual maintenance events for 3 weeks
4. Go/no-go review with plant managers

### Milestones

- [x] Edge gateways installed at Brackwater
- [ ] Edge gateways installed at Denholt, Sundale, Ashcombe
- [ ] Shadow-mode results reviewed
- [ ] Go/no-go decision documented

### Risks

> [!note]
> Shadow-mode deployment is *non-negotiable* for this phase. Skipping it to save time would remove our only safety net against false alarms disrupting plant operations.

- **Alert fatigue**: If the false-positive rate exceeds targets during shadow mode, plant staff may begin ignoring alerts entirely, a phenomenon reliability literature sometimes calls "alarm blindness."
- **Staffing gaps**: Ashcombe plant is currently short two reliability technicians, which may delay their ability to act on the go/no-go review findings.

---

## Phase 5: Full Rollout & Handover

**Duration:** 14 weeks
**Owner:** *Julian Castellane*

### Goals

Scale the platform to all remaining 8 plants, transition operational ownership to the **Plant Reliability Team**, and formally close the project.

### Key Activities

1. Staged rollout in three waves of plants (grouped by regional proximity)
2. Training sessions for reliability engineers
3. Knowledge transfer documentation
4. 90-day hypercare support window

### Milestones

| Milestone | Target Date | Owner |
|---|---|---|
| Wave 1 rollout (3 plants) complete | Week 4 | Julian Castellane |
| Wave 2 rollout (3 plants) complete | Week 8 | Julian Castellane |
| Wave 3 rollout (2 plants) complete | Week 12 | Julian Castellane |
| Hypercare period concludes | Week 14 | Renata Oyelaran |

### Tasks

- [ ] Draft plant onboarding runbook
- [ ] Conduct training workshops (3 sessions, ~25 attendees each)
- [ ] Transfer on-call rotation to Reliability Team
- [ ] Final project retrospective published

### Ris
