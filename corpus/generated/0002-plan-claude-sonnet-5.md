# Project Nightingale: Predictive Maintenance Platform

## Executive Summary

Project Nightingale is a twelve-month initiative to design, build, and deploy a predictive maintenance platform for the fictional manufacturing conglomerate **Halberd Industrial Group**. The platform will ingest sensor telemetry from factory-floor equipment, apply machine learning models to forecast failures, and surface actionable alerts to maintenance teams before breakdowns occur. This document outlines the phases, milestones, ownership structure, and risk register for the initiative.

The core hypothesis driving this project is that unplanned downtime can be reduced by at least 35% within the first two quarters of full deployment, translating to an estimated savings of $4.2M annually across the Ashwood and Correlon manufacturing plants.

---

## 1. Project Objectives

- Reduce unplanned equipment downtime by 35% within six months of go-live.
- Build a scalable data ingestion pipeline capable of handling 50,000 sensor events per second.
- Deploy interpretable ML models with a false-positive rate below 8%.
- Train 120 maintenance technicians on the new alerting dashboard.
- Achieve ISO 55000-aligned asset management documentation by project close.

---

## 2. Team & Ownership

| Role | Owner | Responsibility |
|---|---|---|
| Executive Sponsor | Marguerite Doyle (VP Operations) | Budget approval, strategic alignment |
| Project Lead | Tobias Renn | Day-to-day coordination, reporting |
| Data Engineering Lead | Priya Ashcombe | Ingestion pipeline, data lake architecture |
| ML Lead | Dr. Elias Fahnstrom | Model design, validation, deployment |
| Platform/DevOps Lead | Ngozi Baptiste | Infrastructure, CI/CD, monitoring |
| Change Management Lead | Callum Wexley | Training, adoption, documentation |
| QA Lead | Simone Achterberg | Test planning, defect tracking |

---

## 3. Phases and Milestones

### Phase 0 — Discovery & Feasibility (Weeks 1–4)

Objectives: validate data availability, confirm sensor coverage, and align stakeholders on success metrics.

**Milestones:**
1. Sensor inventory audit completed across both plants.
2. Feasibility report signed off by Executive Sponsor.
3. Data governance agreement finalized with Legal.

> [!note]
> The feasibility report must explicitly document sensor sampling rates. Several legacy vibration sensors on the Correlon line report at 2 Hz, which may be insufficient for detecting early-stage bearing faults.

---

### Phase 1 — Data Infrastructure (Weeks 5–12)

Objectives: build the ingestion pipeline, establish the data lake, and set up streaming infrastructure.

**Milestones:**
1. Kafka-based ingestion layer operational.
2. Raw-to-curated ETL pipeline deployed on staging.
3. Data quality dashboards live for engineering review.

Sample configuration for the ingestion service:

```yaml
service: nightingale-ingest
version: 1.4.0
kafka:
  brokers:
    - broker01.halberd.internal:9092
    - broker02.halberd.internal:9092
  topics:
    - name: sensor.vibration.raw
      partitions: 24
      retention_ms: 604800000
    - name: sensor.thermal.raw
      partitions: 12
      retention_ms: 604800000
throughput_target_events_per_sec: 50000
```

**Task checklist for Phase 1:**

- [x] Provision Kafka cluster in staging environment
- [x] Configure schema registry for sensor payloads
- [x] Establish raw data retention policy (7 days)
- [ ] Load-test ingestion pipeline at 1.5x expected peak
- [ ] Finalize data lake partitioning strategy
- [ ] Sign off on data quality SLA with plant managers

---

### Phase 2 — Model Development (Weeks 10–20, overlapping Phase 1)

Objectives: develop, validate, and benchmark predictive failure models.

**Milestones:**
1. Baseline statistical model established (moving average threshold).
2. Gradient-boosted survival model trained on historical failure logs.
3. Model achieves target precision/recall on holdout set.

The core failure-risk scoring function estimates the instantaneous hazard $h(t)$ for a given asset, where $t$ represents operating hours since last maintenance. We model this using a Weibull-based hazard function:

$$
h(t) = \frac{\beta}{\eta} \left( \frac{t}{\eta} \right)^{\beta - 1}
$$

Here, $\beta$ is the shape parameter (estimated at 2.3 for Correlon stamping presses, indicating increasing failure rate over time) and $\eta$ is the scale parameter (approximately 1,840 operating hours). Technicians receive an alert when the cumulative hazard exceeds a threshold $\theta = 0.65$.

**Task checklist for Phase 2:**

- [x] Assemble labeled failure dataset (2019–2024 maintenance logs)
- [x] Establish baseline model performance benchmarks
- [ ] Complete feature engineering for thermal degradation signals
- [ ] Run cross-validation across plant-specific subsets
- [ ] Document model interpretability report (SHAP values)
- [ ] Obtain sign-off from Reliability Engineering team

Nested breakdown of the feature engineering workstream:

- Vibration features
  - Time-domain statistics
    - RMS amplitude
    - Kurtosis
    - Crest factor
  - Frequency-domain statistics
    - Spectral peak frequency
    - Harmonic ratio
- Thermal features
  - Rolling average temperature
    - 15-minute window
    - 60-minute window
  - Rate of temperature change
- Operational context features
  - Shift identifier
  - Load percentage
    - Rated load ratio
    - Peak load deviation

---

### Phase 3 — Platform Integration (Weeks 18–28)

Objectives: integrate the ML scoring service with the alerting dashboard and existing CMMS (Computerized Maintenance Management System).

**Milestones:**
1. Scoring service deployed behind internal API gateway.
2. Alert dashboard MVP available to pilot users at Ashwood plant.
3. CMMS integration validated end-to-end (alert → work order creation).

```python
def compute_alert(hazard_score: float, threshold: float = 0.65) -> str:
    """Return alert severity based on cumulative hazard score."""
    if hazard_score >= threshold:
        return "CRITICAL"
    elif hazard_score >= threshold * 0.7:
        return "WARNING"
    else:
        return "NORMAL"
```

**Task checklist for Phase 3:**

- [x] Deploy scoring API to internal Kubernetes cluster
- [ ] Complete dashboard UI review with pilot technicians
- [ ] Integrate CMMS webhook for automatic work order generation
- [ ] Conduct security review of API gateway
- [ ] Run end-to-end latency test (target: under 3 seconds from event to alert)

> [!warning]
> The CMMS vendor, Fennimore Systems, has indicated their webhook API may deprecate the current authentication scheme in Q3. This must be tracked closely to avoid integration breakage mid-pilot.

---

### Phase 4 — Pilot Deployment (Weeks 26–36)

Objectives: run a controlled pilot at the Ashwood plant with a subset of 18 machines before full rollout.

**Milestones:**
1. Pilot kickoff with 18 machines instrumented and monitored.
2. Weekly review cadence established with plant maintenance supervisors.
3. Pilot results report completed, including false-positive analysis.

Pilot success criteria include a false-positive rate below 8%, calculated as:

$$
FPR = \frac{FP}{FP + TN}
$$

**Task checklist for Phase 4:**

- [ ] Instrument 18 pilot machines with upgraded sensors
- [ ] Train pilot technicians (target: 12 technicians)
- [ ] Collect weekly feedback via structured survey
- [ ] Calculate pilot-phase downtime reduction percentage
- [ ] Present pilot findings to Executive Sponsor

---

### Phase 5 — Full Rollout & Handover (Weeks 34–48)

Objectives: scale the platform to all 140 machines across both plants, complete training, and transition to steady-state operations.

**Milestones:**
1. Full sensor coverage achieved across Ashwood and Correlon.
2. All 120 technicians trained and certified on the dashboard.
3. Steady-state support model handed off to IT Operations.
4. Final project retrospective conducted.

**Task checklist for Phase 5:**

- [ ] Complete phased rollout schedule (10 machines/week)
- [ ] Deliver technician certification program
- [ ] Publish operations runbook
- [ ] Conduct 30-day post-rollout stability review
- [ ] Close out project budget reconciliation

---

## 4. Timeline Overview

| Phase | Start | End | Owner |
|---|---|---|---|
| Phase 0: Discovery | Week 1 | Week 4 | Tobias Renn |
| Phase 1: Data Infrastructure | Week 5 | Week 12 | Priya Ashcombe |
| Phase 2: Model Development | Week 10 | Week 20 | Dr. Elias Fahnstrom |
| Phase 3: Platform Integration | Week 18 | Week 28 | Ngozi Baptiste |
| Phase 4: Pilot Deployment | Week 26 | Week 36 | Callum Wexley |
| Phase 5: Full Rollout | Week 34 | Week 48 | Tobias Renn |

---

## 5. Risk Register

| ID | Risk Description | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R-01 | Legacy sensors insufficient sampling rate for early fault detection | Medium | High | Prioritize sensor upgrade budget for critical assets identified in Phase 0 | Priya Ashcombe |
| R-02 | CMMS vendor API deprecation disrupts integration | Medium | Medium | Maintain fallback manual work-order path; engage vendor early | Ngozi Baptiste |
| R-03 | Model false-positive rate exceeds threshold, causing alert fatigue | Medium | High | Iterative threshold tuning during pilot; technician feedback loop | Dr. Elias Fahnstrom |
| R-04 | Technician adoption resistance due to workflow disruption | High | Medium | Structured change management program, early involvement of floor supervisors | Callum Wexley |
| R-05 | Budget overrun due to sensor hardware costs | Low | High | Lock in hardware vendor pricing during Phase 1; contingency reserve of 12% | Marguerite Doyle |
| R-06 | Data quality issues from inconsistent maintenance logs | Medium | Medium | Data cleansing sprint in Phase 1; manual audit of top 200 failure records | Simone Achterberg |
| R-07 | Key personnel attrition during model development phase | Low | High | Cross-training within ML team; documentation of model design decisions | Dr. Elias Fah
