# Project Nimbus: Smart Irrigation Rollout

## Overview
Project Nimbus deploys a solar-powered, sensor-driven irrigation network across the Calder Valley agricultural cooperative. The initiative spans 14 weeks and targets a 30% reduction in water usage while maintaining crop yield within $\pm 5\%$ of baseline.

## Phases and Milestones

| Phase | Duration | Milestone | Owner |
|---|---|---|---|
| Discovery | Weeks 1–2 | Site survey & soil moisture baseline complete | Priya Kapoor |
| Design | Weeks 3–5 | Sensor network architecture approved | Marcus Oduya |
| Procurement | Weeks 6–7 | Hardware (nodes, valves, gateways) delivered | Elena Vasquez |
| Deployment | Weeks 8–10 | 50 field nodes installed and calibrated | Tomás Reyes |
| Integration | Weeks 11–12 | Dashboard live with real-time telemetry | Priya Kapoor |
| Validation | Weeks 13–14 | Yield and water-savings report signed off | Marcus Oduya |

## Technical Notes
Node placement density $n$ is derived from field area $A$ (hectares) and desired sensor spacing $s$:

$$
n = \left\lceil \frac{A \times 10^4}{s^2} \right\rceil
$$

Configuration for each gateway is stored as follows:

```yaml
gateway:
  id: NMB-GW-07
  region: calder-valley-east
  reporting_interval_s: 300
  moisture_threshold: 0.42
  battery_min_v: 3.3
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gateway firmware bugs | Medium | High | Staged rollout, rollback scripts |
| Soil sensor drift | Medium | Medium | Monthly recalibration cycle |
| Cooperative funding delay | Low | High | Secure bridge financing from Calder Trust |
| Weather-related install delays | High | Medium | Buffer 1 week per deployment phase |

## Success Metric
Overall efficiency score $\eta$ combines water savings and yield stability, targeting $\eta \geq 0.78$ by project close, reviewed jointly by Elena Vasquez and Tomás Reyes.
