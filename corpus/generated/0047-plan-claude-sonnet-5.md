# Project Aurora: Predictive Maintenance Platform

## Executive Summary

**Project Aurora** is a 9-month initiative to design, build, and deploy a predictive maintenance platform for the industrial sensor network operated by **Meridian Fabrication Corp**. The platform will ingest telemetry from over 4,200 edge devices, apply machine learning models to forecast equipment failure, and reduce unplanned downtime by an estimated *35%* within the first year of full deployment.

This document outlines the phases, milestones, ownership structure, and risk register for the project. All names, figures, and organizational details are fictional and constructed solely for planning illustration.

---

## 1. Project Goals

- Reduce unplanned equipment downtime across **12 manufacturing plants**
- Build a real-time anomaly detection pipeline with sub-second latency
- Establish a unified data lake for sensor telemetry (~18 TB/month ingestion)
- Deliver an executive dashboard with *predictive risk scores* per machine

> [!note]
> Success criteria will be reviewed quarterly by the Steering Committee, chaired by **Dana Whitfield** (VP of Operations). Metrics not meeting threshold by Q3 will trigger a scope reassessment.

---

## 2. Team & Ownership

| Role | Owner | Responsibility |
|---|---|---|
| Executive Sponsor | Dana Whitfield | Budget approval, strategic alignment |
| Program Manager | Rafael Ocampo | Timeline, cross-team coordination |
| Data Engineering Lead | Priya Anand | Ingestion pipeline, data lake |
| ML Lead | Tomasz Wieczorek | Model development, validation |
| Platform/DevOps Lead | Keiko Sato | Infrastructure, CI/CD, deployment |
| QA Lead | Marcus Ibe | Test strategy, regression suites |
| Change Management Lead | Sofia Lindqvist | Training, adoption, documentation |

---

## 3. Phases and Milestones

### Phase 0 — Discovery & Scoping (Weeks 1–4)

**Owner:** Rafael Ocampo

- Stakeholder interviews across all 12 plants
- Inventory of existing sensor hardware and firmware versions
  - Legacy PLC controllers (Siemens S7-series)
    - Firmware audit
      - Identify units running versions below v4.2
      - Flag for mandatory upgrade before integration
  - Modern IoT gateways (Aurora-Edge v2)
    - Compatibility check with new telemetry schema
- Finalize data governance policy with Legal & Compliance

**Milestone 0.1:** Discovery report signed off — *Week 4*

---

### Phase 1 — Data Infrastructure Build (Weeks 5–12)

**Owner:** Priya Anand

- Deploy Kafka-based streaming backbone across regional hubs
- Build ingestion connectors for each device family
- Establish schema registry and data quality checks

```yaml
pipeline:
  name: aurora-ingest
  sources:
    - type: mqtt
      topic: plant-floor/telemetry/#
      qos: 1
    - type: opc-ua
      endpoint: opc.tcp://gateway-07.meridian.local:4840
  sink:
    type: kafka
    topic: raw-telemetry
    partitions: 24
  retention_days: 90
```

**Milestone 1.1:** Streaming backbone live in 3 pilot plants — *Week 9*
**Milestone 1.2:** Full 12-plant ingestion operational — *Week 12*

> [!warning]
> Plant 7 (Kolvara site) uses a non-standard voltage sensor calibration. Ingestion connectors must apply a correction factor $c = 1.084$ or telemetry values will be skewed by roughly 8%.

---

### Phase 2 — Model Development (Weeks 10–20, overlapping Phase 1)

**Owner:** Tomasz Wieczorek

- Feature engineering from vibration, temperature, and current draw signals
- Baseline models: gradient-boosted trees for failure classification
- Advanced models: LSTM-based time-series forecasting for remaining useful life (RUL)

The failure probability for a given machine at time $t$ is modeled as a function of accumulated stress $S(t)$ and a decay-adjusted baseline hazard $\lambda_0$:

$$
P_{\text{fail}}(t) = 1 - \exp\left(-\int_0^t \lambda_0 \cdot e^{\beta S(\tau)} \, d\tau\right)
$$

where $\beta$ is a fitted sensitivity coefficient specific to each equipment class, and $S(\tau)$ is derived from normalized vibration amplitude readings.

Model evaluation will use *precision-recall* curves rather than plain accuracy, since failure events are rare (~0.4% of all observations), and the team will track the $F_1$ score alongside a custom cost-weighted metric.

**Milestone 2.1:** Baseline model achieving $F_1 \geq 0.62$ on holdout set — *Week 15*
**Milestone 2.2:** LSTM RUL model validated against 6 months of historical failure logs — *Week 20*

---

### Phase 3 — Platform Integration & Dashboard (Weeks 18–26)

**Owner:** Keiko Sato

- Build model-serving layer (containerized inference microservices)
- Integrate risk scores into executive dashboard
- Set up alerting thresholds tied to maintenance ticketing system

Nested breakdown of dashboard components:

- Frontend
  - Risk overview grid
    - Color-coded severity (green/amber/red)
      - Red threshold configurable per plant manager
  - Drill-down machine detail view
    - Sensor trend charts
    - Maintenance history log
- Backend
  - REST API gateway
    - Rate limiting at 500 req/min per client
  - Authentication via SSO integration
- Alerting
  - Email digest (daily)
  - SMS escalation for *critical* risk scores only

**Milestone 3.1:** Internal alpha dashboard released to pilot plants — *Week 22*
**Milestone 3.2:** Alerting system integrated with ticketing (ServiceNow) — *Week 26*

---

### Phase 4 — Validation & Rollout (Weeks 24–32)

**Owner:** Marcus Ibe

- Shadow-mode testing: model predictions run alongside existing manual inspection process without acting on alerts
- Comparison of predicted vs. actual failures over a 6-week window
- Full rollout plan across remaining 9 plants

**Milestone 4.1:** Shadow-mode report complete, false-positive rate below 12% — *Week 30*
**Milestone 4.2:** Full production rollout across all 12 plants — *Week 32*

> [!note]
> Rollout order will prioritize plants with the highest historical downtime cost, starting with **Plant 3 (Renfield)** and **Plant 9 (Calder Ridge)**.

---

### Phase 5 — Change Management & Handoff (Weeks 28–36)

**Owner:** Sofia Lindqvist

- Training sessions for plant maintenance teams
- Documentation of runbooks and escalation procedures
- Transition support tickets to steady-state operations team

**Milestone 5.1:** Training completed for all plant supervisors — *Week 34*
**Milestone 5.2:** Project formally closed and handed to Operations — *Week 36*

---

## 4. Timeline Summary

| Phase | Weeks | Owner | Key Deliverable |
|---|---|---|---|
| 0. Discovery | 1–4 | Rafael Ocampo | Discovery report |
| 1. Data Infrastructure | 5–12 | Priya Anand | Streaming backbone |
| 2. Model Development | 10–20 | Tomasz Wieczorek | Validated RUL model |
| 3. Platform Integration | 18–26 | Keiko Sato | Executive dashboard |
| 4. Validation & Rollout | 24–32 | Marcus Ibe | Full production rollout |
| 5. Change Management | 28–36 | Sofia Lindqvist | Project closure |

---

## 5. Budget Overview (Illustrative)

- Infrastructure (cloud + on-prem hybrid): **$412,000**
- Personnel (9-month allocation across 7 core roles): **$1,860,000**
- Hardware upgrades (sensor firmware, gateway replacements): **$275,000**
- Contingency reserve (*15% of total*): **$378,750**

**Total estimated budget:** approximately **$2,925,750**

---

## 6. Risk Register

| ID | Risk | Likelihood | Impact | Owner | Mitigation |
|---|---|---|---|---|---|
| R1 | Legacy PLC firmware incompatible with new schema | High | High | Priya Anand | Early audit in Phase 0; budget for firmware upgrades |
| R2 | Model false-positive rate too high, causing alert fatigue | Medium | High | Tomasz Wieczorek | Tune thresholds during shadow-mode testing |
| R3 | Network bandwidth insufficient at remote plants | Medium | Medium | Keiko Sato | Local edge buffering with delayed sync |
| R4 | Staff resistance to new dashboard workflows | Medium | Medium | Sofia Lindqvist | Early involvement of plant supervisors in design reviews |
| R5 | Kolvara site calibration error propagates undetected | Low | High | Priya Anand | Automated calibration validation checks in ingestion layer |
| R6 | Budget overrun due to hardware replacement scope creep | Medium | High | Rafael Ocampo | Fixed hardware budget with change-control approval gate |
| R7 | Key ML engineer departure mid-project | Low | High | Tomasz Wieczorek | Cross-training and documented model handoff procedures |

> [!warning]
> Risk **R2** is considered the most likely to derail the Phase 4 timeline. If the false-positive rate exceeds 20% during shadow-mode testing, the Steering Committee will convene an emergency review before proceeding to full rollout.

---

## 7. Communication Plan

- **Weekly** stand-ups within each workstream (Data, ML, Platform, QA)
- **Bi-weekly** cross-team sync led by Rafael Ocampo
- **Monthly** Steering Committee review with Dana Whitfield
- **Quarterly** all-hands presentation to plant managers

All meeting notes and decisions will be logged in the shared Aurora project wiki, with action items tracked in the ==central issue tracker== to ensure accountability across distributed teams.

---

## 8. Success Metrics

By project closure (Week 36), the following targets define success:

1. Unplanned downtime reduced by *at least 30%* compared to the prior 12-month baseline
2. Model precision at or above $0.75$ for high-severity failure predictions
3. Dashboard adoption rate of *90%* among plant supervisors within 60 days of rollout
4. Mean time to detect (MTTD) equipment anomalies reduced from ~48 hours to under $6$ hours

These metrics will be formally reviewed in a post-project retrospective, led jointly by Rafael Ocampo and Dana Whitfield, with findings archived for future platform initiatives such as the tentatively planned **Project Solstice** expansion into supply-chain forecasting.

---

## 
