# Project Phoenix: Predictive Maintenance Platform
## Project Plan

**Document Owner:** Elena Vasquez, Program Director
**Last Updated:** March 14, 2025
**Status:** Active — Phase 2 in progress

---

## 1. Executive Summary

Project Phoenix aims to deliver a predictive maintenance platform for the industrial sensor network operated by Marlowe Dynamics. The system will ingest telemetry from approximately 4,200 field devices, apply anomaly detection models, and surface actionable alerts to maintenance crews before equipment failures occur. The target outcome is a 30% reduction in unplanned downtime within two fiscal quarters of full deployment.

> [!note]
> This plan assumes stable funding of $1.85M across four phases. Any budget cut greater than 12% will trigger a scope review as described in Section 5.

---

## 2. Objectives and Success Metrics

The project is considered successful if the following hold:

- Mean time to detect (MTTD) anomalies drops below 18 minutes, down from the current baseline of 74 minutes.
- False positive rate for alerts stays under $\epsilon = 0.05$.
- System uptime meets or exceeds 99.6% across the pilot fleet.
- Onboarding cost per new sensor cluster falls below $210.

The anomaly scoring function used by the detection engine combines a weighted residual signal $r_t$ with a temporal decay term. For a sensor stream indexed by time $t$, the composite health score $H(t)$ is defined as:

$$
H(t) = \sum_{i=1}^{n} w_i \cdot r_{t-i} \cdot e^{-\lambda i} \;+\; \beta \cdot \sigma(t)
$$

where $w_i$ are learned weights, $\lambda$ is a decay constant tuned per device class, and $\sigma(t)$ represents the rolling standard deviation of the raw signal over a 45-minute window.

---

## 3. Phases and Milestones

### Phase 0 — Discovery & Feasibility (Weeks 1–4)

Goals: validate data availability, confirm sensor firmware compatibility, and produce a technical feasibility memo.

| Milestone | Target Date | Owner |
|---|---|---|
| Data audit of 12 pilot facilities complete | Week 2 | Priya Nandakumar |
| Firmware compatibility matrix published | Week 3 | Tomas Reyes |
| Feasibility memo approved by steering committee | Week 4 | Elena Vasquez |

> [!warning]
> Two of the twelve pilot facilities (Site 7 and Site 11) still run legacy firmware version 2.3, which does not support the required telemetry sampling rate. Migration must be scoped separately or those sites excluded from the pilot.

---

### Phase 1 — Data Infrastructure (Weeks 5–12)

Goals: build the ingestion pipeline, establish the time-series data lake, and implement schema validation.

| Milestone | Target Date | Owner |
|---|---|---|
| Kafka ingestion cluster provisioned | Week 6 | Tomas Reyes |
| Schema registry and validation rules deployed | Week 8 | Sana Whitfield |
| Historical backfill (18 months of data) completed | Week 10 | Priya Nandakumar |
| Data quality sign-off from QA team | Week 12 | Marcus Ollie |

A simplified version of the ingestion configuration is shown below for reference during implementation reviews:

```yaml
ingestion:
  cluster_name: phoenix-kafka-prod
  partitions: 24
  replication_factor: 3
  retention_hours: 4320
  topics:
    - name: sensor.raw.temperature
      schema: temp_v3
    - name: sensor.raw.vibration
      schema: vib_v2
    - name: sensor.raw.pressure
      schema: pressure_v1
  compression: snappy
  consumer_group: phoenix-anomaly-engine
```

---

### Phase 2 — Model Development (Weeks 10–20, overlapping Phase 1)

Goals: train baseline anomaly detection models, validate against labeled failure events, and establish the retraining cadence.

| Milestone | Target Date | Owner |
|---|---|---|
| Baseline isolation-forest model trained | Week 13 | Dr. Aisha Kwarteng |
| Labeled failure dataset (n = 860 events) finalized | Week 14 | Marcus Ollie |
| Model achieves recall ≥ 0.87 on holdout set | Week 17 | Dr. Aisha Kwarteng |
| Retraining pipeline automated (weekly cadence) | Week 20 | Sana Whitfield |

> The hardest part of this phase is not the modeling — it is convincing operators that a 13% miss rate on rare failure modes is an improvement, not a shortfall, over the manual inspection process it replaces.
> — Dr. Aisha Kwarteng, Lead Data Scientist

---

### Phase 3 — Platform Integration (Weeks 18–28)

Goals: connect the alerting engine to the maintenance ticketing system, build operator dashboards, and run integration tests across all pilot sites.

| Milestone | Target Date | Owner |
|---|---|---|
| Alert-to-ticket integration with ServiceHub API | Week 20 | Tomas Reyes |
| Operator dashboard v1 released to 3 pilot sites | Week 23 | Sana Whitfield |
| End-to-end load test (peak 12,000 events/sec) passed | Week 26 | Marcus Ollie |
| Full pilot rollout across 10 sites | Week 28 | Elena Vasquez |

---

### Phase 4 — Stabilization & Handover (Weeks 29–36)

Goals: monitor production performance, tune alert thresholds, and transition ownership to the Site Reliability team.

| Milestone | Target Date | Owner |
|---|---|---|
| 30-day stability report published | Week 32 | Priya Nandakumar |
| Threshold tuning workshop with operators | Week 33 | Dr. Aisha Kwarteng |
| Runbook and on-call handover to SRE | Week 35 | Marcus Ollie |
| Project closeout review | Week 36 | Elena Vasquez |

---

## 4. Team and Ownership

| Name | Role | Primary Responsibility |
|---|---|---|
| Elena Vasquez | Program Director | Overall delivery, steering committee liaison |
| Priya Nandakumar | Data Engineering Lead | Historical data, backfill, audits |
| Tomas Reyes | Platform Engineer | Infrastructure, ingestion, integrations |
| Sana Whitfield | Software Engineer | Dashboards, schema validation, retraining automation |
| Dr. Aisha Kwarteng | Lead Data Scientist | Model design, evaluation, tuning |
| Marcus Ollie | QA & Reliability Lead | Testing, load validation, runbooks |

---

## 5. Budget Overview

| Category | Allocated ($) | Notes |
|---|---|---|
| Infrastructure (cloud, storage) | 620,000 | Includes 3-year reserved capacity discount |
| Personnel (contractors) | 740,000 | 6 FTE-equivalents across 36 weeks |
| Data licensing & firmware upgrades | 210,000 | Covers Site 7 and Site 11 migration |
| Contingency reserve | 280,000 | ~15% of total budget |
| **Total** | **1,850,000** | |

---

## 6. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Legacy firmware at Site 7/11 delays onboarding | High | Medium | Parallel-track firmware upgrade budget in Phase 0 | Tomas Reyes |
| R2 | Labeled failure dataset too small for rare fault classes | Medium | High | Augment with synthetic fault injection; partner with vendor logs | Dr. Aisha Kwarteng |
| R3 | ServiceHub API rate limits throttle alert delivery | Medium | Medium | Negotiate higher rate tier; implement local queue buffer | Marcus Ollie |
| R4 | Operator resistance to automated alerts | Medium | High | Early workshops, transparent false-positive reporting | Elena Vasquez |
| R5 | Cloud cost overrun from retention policy misconfiguration | Low | Medium | Automated cost alerts at 80% of monthly budget threshold | Priya Nandakumar |
| R6 | Key personnel attrition mid-project | Low | High | Cross-training and documented handover procedures | Elena Vasquez |

---

## 7. Communication Plan

- **Weekly:** Engineering standup (async summary posted to #phoenix-eng)
- **Bi-weekly:** Steering committee update (15-minute readout + written memo)
- **Monthly:** Stakeholder demo with pilot site operators
- **Ad hoc:** Incident reports for any P1/P2 production issue within 4 hours of resolution

---

## 8. Assumptions and Dependencies

This plan depends on the following holding true throughout execution:

- Pilot site network connectivity remains above 98% availability.
- The ServiceHub ticketing vendor does not deprecate its v2 API before Week 28.
- Contractor staffing for the data science team remains at 3 FTE from Week 10 onward.
- No regulatory changes affecting sensor data retention occur during the project window.

Any violation of these assumptions should trigger a re-baseline discussion at the next steering committee meeting rather than silent scope creep.

---

## 9. Closeout Criteria

The project will be formally closed when all of the following are true: the 30-day stability report shows MTTD below the 18-minute target, the SRE team has signed off on runbook completeness, and the steering committee has approved final budget reconciliation. Until then, Phase 4 remains open and weekly reporting continues.
