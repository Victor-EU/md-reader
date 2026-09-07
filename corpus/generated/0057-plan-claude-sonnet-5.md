# Project Aurora: Predictive Maintenance Platform

## Executive Summary

**Project Aurora** is a 24-week initiative to build a machine learning platform that predicts equipment failures for *Meridian Manufacturing's* fleet of industrial compressors. The project will reduce unplanned downtime by an estimated 30% through real-time sensor analysis and predictive alerting.

---

## Project Phases

### Phase 1: Discovery & Data Audit (Weeks 1–4)

**Objective:** Establish a clear understanding of available sensor data, existing infrastructure, and stakeholder requirements.

- Conduct interviews with plant managers at the *Dellworth* and *Ashcombe* facilities
- Audit historical sensor logs (vibration, temperature, pressure) spanning 3 years
- Document data quality issues and gaps
- Define success metrics with the executive sponsor, **Priya Nataraj**

**Milestone 1.1:** Data audit report signed off — *End of Week 4*

> [!note]
> Approximately 18% of historical records from the Dellworth facility are missing timestamps. This will require imputation strategies before modeling begins.

**Owner:** *Tomás Herrera* (Data Engineering Lead)

---

### Phase 2: Infrastructure & Pipeline Build (Weeks 5–9)

**Objective:** Construct a scalable ingestion pipeline capable of processing streaming sensor data at ==2,400 events per second==.

Key tasks:
1. Deploy a Kafka-based ingestion layer
2. Build a feature store using time-windowed aggregations
3. Establish a data validation layer with automated schema checks

```python
def compute_rolling_features(df, window="15min"):
    """Compute rolling statistical features for sensor streams."""
    df = df.set_index("timestamp")
    features = df.rolling(window).agg(
        {"vibration": ["mean", "std"], "temperature": ["max", "min"]}
    )
    return features.dropna()
```

**Milestone 2.1:** Ingestion pipeline processes live data from 3 test sensors — *Week 7*
**Milestone 2.2:** Feature store validated against golden dataset — *Week 9*

**Owner:** *Ingrid Solberg* (Platform Architect)

> [!warning]
> The Kafka cluster sizing was estimated using peak-load assumptions from Q2. If Meridian expands sensor coverage before Week 9, throughput requirements may exceed current capacity by up to 40%.

---

### Phase 3: Model Development (Weeks 10–16)

**Objective:** Train and validate predictive models for compressor failure classification.

The core failure probability model uses a logistic transformation of a risk score $z$, where:

$$
P(\text{failure} \mid z) = \frac{1}{1 + e^{-z}}, \quad z = \beta_0 + \sum_{i=1}^{n} \beta_i x_i
$$

Here $x_i$ represents normalized sensor features such as vibration amplitude and thermal drift, and $\beta_i$ are learned coefficients.

Tasks include:
- Feature engineering using domain knowledge from *Dr. Felix Okonjo* (Reliability Engineering)
- Training gradient-boosted tree ensembles and comparing against the logistic baseline
- Hyperparameter tuning via Bayesian optimization
- Cross-validation using time-based splits to avoid data leakage

**Milestone 3.1:** Baseline model achieves *AUC ≥ 0.82* on holdout set — *Week 13*
**Milestone 3.2:** Final model selected and documented — *Week 16*

**Owner:** *Chen Wei* (Lead Data Scientist)

---

### Phase 4: Integration & Alerting (Weeks 17–20)

**Objective:** Integrate the trained model into a live alerting dashboard for plant operators.

- Build REST API endpoints for real-time inference
- Develop the operator-facing dashboard using a lightweight visualization framework
- Implement alert thresholds calibrated with plant engineers
- Conduct user acceptance testing (UAT) with 12 operators across both facilities

**Milestone 4.1:** API achieves median inference latency under 120ms — *Week 18*
**Milestone 4.2:** UAT completed with ≥ 85% operator satisfaction — *Week 20*

**Owner:** *Naomi Fitzgerald* (Product Manager)

---

### Phase 5: Deployment & Monitoring (Weeks 21–24)

**Objective:** Roll out the platform to production and establish ongoing monitoring.

- Deploy to production environment with blue-green rollout strategy
- Configure drift detection to flag when feature distributions shift beyond a threshold $\delta = 0.05$
- Train plant staff on dashboard usage
- Establish a monthly model-retraining cadence

**Milestone 5.1:** Production deployment complete — *Week 22*
**Milestone 5.2:** First monitoring report delivered to stakeholders — *Week 24*

**Owner:** *Tomás Herrera* (Data Engineering Lead)

---

## Roles & Ownership Summary

| Role | Owner | Primary Phase |
|---|---|---|
| Executive Sponsor | Priya Nataraj | All |
| Data Engineering Lead | Tomás Herrera | 1, 5 |
| Platform Architect | Ingrid Solberg | 2 |
| Lead Data Scientist | Chen Wei | 3 |
| Product Manager | Naomi Fitzgerald | 4 |
| Reliability Consultant | Dr. Felix Okonjo | 3 |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sensor data quality degrades further | Medium | High | Implement automated anomaly detection on ingestion; escalate to plant IT weekly |
| Model performance falls below AUC target | Medium | High | Maintain fallback rule-based alerting system as backup |
| Kafka cluster under-provisioned | Low | Medium | Reassess throughput needs at Week 6 checkpoint |
| Operator adoption resistance | Medium | Medium | Early UAT involvement; iterative dashboard feedback loops |
| Key personnel turnover (Chen Wei's team) | Low | High | Cross-train two backup data scientists by Week 12 |

> [!warning]
> If the AUC target is not met by Week 13, the project timeline for Phase 4 will slip by an estimated 2 weeks, as model refinement cannot be parallelized with integration work.

---

## Budget Overview (Illustrative)

- Personnel: $410,000
- Infrastructure (cloud compute, storage): $95,000
- Third-party tooling licenses: $22,500
- Contingency (10%): $52,750

**Total estimated budget:** $580,250

---

## Communication Plan

- **Weekly standups:** Every Monday, 9:00 AM, led by phase owner
- **Bi-weekly stakeholder demo:** Fridays, alternating weeks
- **Monthly steering committee review:** Chaired by Priya Nataraj

*Documentation and meeting notes will be centralized in the shared project workspace, accessible to all stakeholders.*

---

## Closing Notes

This plan represents our current best estimate of scope, timeline, and resourcing. Adjustments will be made at each phase gate based on actual progress against milestones. The guiding principle throughout Project Aurora is ==incremental validation==: no phase should proceed until its predecessor's milestones are demonstrably met.
