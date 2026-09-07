# Project Harbor Lantern — Customer Portal Rebuild

**Sponsor:** Dela Amankwah, VP Digital Services
**Project Manager:** Rion Vasquez
**Target Launch:** 14 April 2026
**Budget:** $412,000

> Our goal is not a prettier portal. It is a portal that lets a customer resolve a billing dispute in under four minutes, without calling anyone.

---

## Phases & Milestones

| Phase | Window | Milestone | Owner |
|---|---|---|---|
| 1. Discovery | Jan 6 – Jan 30 | 22 customer interviews synthesized | Priya Nandakumar |
| 2. Architecture | Feb 2 – Feb 20 | Signed-off API contract v1.0 | Tomas Brandeis |
| 3. Build (Sprints 1–5) | Feb 23 – Apr 3 | Feature freeze, 87% test coverage | Ines Okafor |
| 4. Hardening | Apr 6 – Apr 10 | Zero Sev-1 defects open | Marcus Lindqvist |
| 5. Launch & Care | Apr 13 – May 8 | 95% traffic migrated | Rion Vasquez |

## Success Metrics

- Median dispute resolution time: **11.4 min → 4.0 min**
- Support ticket deflection: **+28%**
- Portal uptime during care period: **99.9%**

## Rollout Configuration

```yaml
release:
  name: harbor-lantern-1.0
  strategy: canary
  stages:
    - cohort: internal_staff
      traffic: 5
      soak_hours: 48
    - cohort: small_business
      traffic: 25
      soak_hours: 72
    - cohort: all_customers
      traffic: 100
  rollback:
    trigger_error_rate: 1.5
    max_rollback_minutes: 12
```

## Risks

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Legacy billing API rate limits throttle canary | Medium | High | Negotiate temporary 3x quota with Vendor Kestrel by Feb 13 | Tomas Brandeis |
| Ines Okafor's team loses two contractors in March | Medium | Medium | Pre-approve bench funding of $34,000 | Dela Amankwah |
| Accessibility audit fails WCAG AA | Low | High | Book external audit for Mar 16, not April | Priya Nandakumar |
| Scope creep from Sales (quote builder) | High | Medium | Park in Phase 6 backlog; sponsor is sole approver | Rion Vasquez |

## Governance

Steering committee meets Tuesdays at 09:30. Decisions unresolved after two meetings escalate to Dela Amankwah, who commits to a written ruling within 48 hours.
