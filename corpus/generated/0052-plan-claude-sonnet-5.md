# Project Aurora: Predictive Maintenance Platform

**Project Sponsor:** Elena Vasquez, VP of Engineering
**Project Lead:** Marcus Chen
**Duration:** 16 weeks (Q1–Q2 2025)

## Overview

Project Aurora aims to build a *predictive maintenance* system for industrial sensor networks. The platform will ingest telemetry data, apply anomaly detection models, and alert maintenance teams before equipment failures occur. Our target is to reduce unplanned downtime by ==35% within the first two quarters== of deployment.

> [!note]
> This plan assumes access to the existing SCADA data lake maintained by the Infrastructure team. Any delays in provisioning access will shift downstream milestones.

## Phases

### Phase 1: Discovery & Data Audit (Weeks 1–3)
- [x] Interview stakeholders from Operations and Facilities
- [x] Catalog existing sensor types and sampling rates
- [ ] Finalize data governance agreement with Legal
- [ ] Establish baseline failure rate metrics

**Owner:** Priya Nair (Data Architect)

### Phase 2: Model Development (Weeks 4–8)
- [ ] Build feature pipeline for vibration and temperature signals
- [ ] Train baseline anomaly detection model
- [ ] Validate against historical failure logs

**Owner:** Tomasz Kowalski (ML Engineer)

The anomaly score $s_i$ for sensor reading $x_i$ is computed using a z-score normalization:

$$
s_i = \frac{x_i - \mu}{\sigma}, \quad \text{flag if } |s_i| > \tau
$$

where $\tau$ is a tunable threshold, typically set between $2.5$ and $3.0$ depending on sensor noise levels.

### Phase 3: Platform Integration (Weeks 9–12)
- [ ] Deploy inference service to staging cluster
- [ ] Integrate alerting with existing ticketing system
- [ ] Load-test with simulated 10,000 sensor streams

**Owner:** Jasmine Ortiz (Platform Engineer)

Example configuration for the alert threshold service:

```yaml
alerting:
  threshold: 2.8
  cooldown_minutes: 15
  channels:
    - pagerduty
    - slack#maintenance-alerts
```

### Phase 4: Rollout & Training (Weeks 13–16)
- [ ] Conduct training sessions for site technicians
- [ ] Gradual rollout to 5 pilot facilities
- [ ] Collect feedback and iterate on false-positive rate

**Owner:** Marcus Chen

## Milestones

| Milestone | Target Date | Status |
|---|---|---|
| Data governance signed | Week 3 | In progress |
| Baseline model trained | Week 8 | Not started |
| Staging deployment live | Week 11 | Not started |
| Pilot rollout complete | Week 16 | Not started |

## Risks

> [!warning]
> The largest risk is **data quality inconsistency** across older sensor firmware versions, which may inflate false-positive rates beyond acceptable thresholds.

1. **Data latency** — SCADA feeds may lag by up to 5 minutes, affecting real-time alerting.
2. *Staffing gap* — Tomasz Kowalski's team is also supporting Project Solstice, creating resource contention.
3. **Vendor dependency** — The vibration sensor vendor, Halden Instruments, has an unresolved firmware bug affecting 12% of deployed units.

As noted during our kickoff review:

> "We should treat the pilot phase as a learning exercise, not a victory lap. Success is measured by how quickly we adapt, not how few problems we find."
> — Elena Vasquez, Project Kickoff Notes

## Next Steps

The immediate priority is closing out Phase 1 data governance approval. Once complete, Phase 2 modeling work can begin in parallel with continued stakeholder interviews for edge-case scenarios not yet documented.
