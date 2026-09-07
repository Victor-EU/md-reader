# Project Nightingale: Predictive Maintenance Platform

**Project Owner:** Elena Vasquez | *Sponsor:* Marcus Chen, VP Engineering

This plan outlines the rollout of an ML-based predictive maintenance system for industrial sensors. The goal is to reduce unplanned downtime by ==35% within two quarters==.

---

## Phases & Milestones

1. **Discovery & Data Audit** (Weeks 1–3)
   - Owner: Priya Nandan
   - Milestone: Data quality report signed off
2. **Model Prototyping** (Weeks 4–8)
   - Owner: Tomasz Building
   - Milestone: Baseline model achieves recall ≥ 0.82
3. **Pilot Deployment** (Weeks 9–12)
   - Owner: Elena Vasquez
   - Milestone: Pilot running on 3 factory lines
4. **Full Rollout** (Weeks 13–20)
   - Owner: Marcus Chen
   - Milestone: All 12 lines instrumented

### Team Structure

- Engineering
  - Data Team
    - Ingestion pipeline (owner: Priya)
    - Feature store (owner: Sam Okafor)
  - ML Team
    - Model training (owner: Tomasz)
    - Model evaluation (owner: Lina Rossi)
- Operations
  - Field deployment (owner: Marcus)

---

## Model Notes

The failure probability for a component is estimated using a logistic function of sensor drift $x$:

$$
P(\text{failure}) = \frac{1}{1 + e^{-(\beta_0 + \beta_1 x)}}
$$

We monitor *daily drift rate* and **cumulative vibration index** as leading indicators.

```python
def failure_probability(x, b0=-4.2, b1=0.87):
    import math
    return 1 / (1 + math.exp(-(b0 + b1 * x)))
```

> [!note]
> All models are retrained weekly using the latest 90-day rolling window.

> [!warning]
> Sensor firmware v2.3 has a known clock-drift bug affecting timestamps.

> "Reliability is not an accident; it is engineered one iteration at a time." — internal team motto

---

## Task Checklist

- [x] Finalize data governance policy
- [x] Secure GPU cluster access
- [ ] Complete pilot line calibration
- [ ] Draft rollback procedure

## Risks

1. **Data drift** — sensors may degrade in accuracy over time.
2. **Vendor delay** — hardware upgrades dependent on third-party supplier.
3. **Model overfitting** — small pilot dataset may not generalize.
