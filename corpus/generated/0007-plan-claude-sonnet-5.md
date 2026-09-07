# Project Phoenix: Predictive Maintenance Platform

## Overview

Project Phoenix aims to build a machine-learning-driven predictive maintenance system for industrial pumps across the Meridian Manufacturing plant network. The system will ingest sensor telemetry and output failure probability scores in near real-time.

> [!note]
> This plan covers the initial 9-month build cycle. A separate operations plan will govern post-launch maintenance.

## Objectives

The core objective is to reduce unplanned downtime by at least 30% within the first year of deployment, while keeping false-positive alert rates below $5\%$.

## Phases and Milestones

### Phase 1 — Discovery & Data Audit (Weeks 1–6)
- Milestone 1.1: Sensor inventory completed across 14 plants
- Milestone 1.2: Data quality report signed off
  - Owner: Priya Nandakumar (Data Engineering Lead)
  - Sub-tasks:
    - Audit historical vibration logs
      - Cross-check timestamps against maintenance tickets
        - Flag mismatches exceeding 2-hour drift
    - Validate temperature sensor calibration
      - Compare against manufacturer spec sheets

### Phase 2 — Model Prototyping (Weeks 7–16)
- Milestone 2.1: Baseline failure-prediction model trained
- Milestone 2.2: Feature importance review completed
  - Owner: Dr. Aiden Voss (ML Research Lead)

We model the probability of failure within a rolling window using a logistic function of aggregated sensor features $x_i$, weighted by learned coefficients $\beta_i$:

$$
P(\text{failure} \mid x) = \frac{1}{1 + e^{-\left(\beta_0 + \sum_{i=1}^{n} \beta_i x_i\right)}}
$$

The team will iterate until the area under the ROC curve exceeds $0.87$ on the holdout set.

```python
def compute_risk_score(features, weights, bias):
    z = bias + sum(w * f for w, f in zip(weights, features))
    return 1 / (1 + 2.71828 ** (-z))
```

### Phase 3 — Pipeline Integration (Weeks 17–24)
- Milestone 3.1: Streaming ingestion pipeline deployed
- Milestone 3.2: Model served via inference API
  - Owner: Tomas Reyes (Platform Engineer)

> [!warning]
> Latency budget for the inference endpoint must not exceed 250ms at the 95th percentile. Exceeding this threshold risks violating the SLA with plant operations teams.

### Phase 4 — Pilot Deployment (Weeks 25–32)
- Milestone 4.1: Live pilot at Plant 7 (Ostrander site)
- Milestone 4.2: Operator feedback loop established
  - Owner: Naomi Ferreira (Product Manager)

### Phase 5 — Full Rollout (Weeks 33–36)
- Milestone 5.1: Deployment to remaining 13 plants
- Milestone 5.2: Post-launch review and handoff to Ops

## Risks

| Risk | Likelihood | Owner | Mitigation |
|---|---|---|---|
| Sensor data gaps at legacy plants | Medium | Priya Nandakumar | Backfill using interpolation, flag low-confidence windows |
| Model drift after seasonal changes | High | Dr. Aiden Voss | Scheduled retraining every 6 weeks |
| API latency spikes under load | Medium | Tomas Reyes | Add caching layer, autoscale inference pods |
| Operator distrust of alerts | Low | Naomi Ferreira | Transparent explainability dashboard |

## Governance Note

As stated in the project charter:

> "No model shall be promoted to production without a documented review by both the ML Research Lead and the Platform Engineering Lead, regardless of performance metrics achieved in staging."

## Budget Summary

Estimated total budget is $412,000, allocated roughly as $45\%$ to engineering salaries, $30\%$ to cloud infrastructure, and the remainder to hardware sensors and contingency.
