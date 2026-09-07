# Project Halyard — Multi-Region Migration of the Meridian Billing Platform

**Document owner:** Priya Raghunathan, Director of Platform Engineering
**Version:** 2.3 (draft) · **Last revised:** 14 March
**Status:** ==Approved for Phase 1 execution; Phases 3–4 pending budget confirmation==

---

## 1. Purpose and Scope

Project Halyard moves the Meridian billing platform from a single-region deployment in `us-cascade-1` to an active/active topology spanning `us-cascade-1` and `eu-tarn-2`. The business driver is twofold: a contractual commitment to **99.98% availability** for our four largest enterprise accounts, and a data-residency requirement from the Halberd Group contract signed in January.

Out of scope: the legacy Ferrous invoicing connector (sunset planned separately), and any change to the customer-facing pricing catalog.

---

## 2. Phases and Milestones

### Phase 0 — Discovery and Baseline *(4 weeks)*

Owner: **Dmitri Solokov**, Staff Architect

1. Inventory all 63 services and classify by statefulness.
2. Capture a 30-day performance baseline (p50/p95/p99 latency, error budget burn).
3. Produce the **Data Classification Register** listing every table containing personally identifiable information.
4. Deliver a written go/no-go recommendation to the steering committee.

- **Milestone M0.1** — Service inventory signed off *(week 2)*
- **Milestone M0.2** — Baseline dashboard live in Kestrel Observability *(week 3)*
- **Milestone M0.3** — Go/no-go decision recorded *(week 4)*

### Phase 1 — Foundation *(7 weeks)*

Owner: **Amara Ndiaye**, Infrastructure Lead

The foundation phase builds the second region without cutting over any traffic.

- Network and identity
  - Provision the `eu-tarn-2` landing zone
    - VPC peering with transit gateway attachment
    - Private DNS zone `internal.meridian.halyard`
      - Health-check records with 15-second TTL
      - Failover policy set to *latency-based* routing
  - Federate IAM roles across regions
    - Break-glass accounts stored in the Vault cluster
      - Quarterly rotation enforced by the Sentinel job
- Data layer
  - Stand up the Ravine Postgres replica set
    - Logical replication for the 11 billing tables
      - Conflict resolution: last-writer-wins with a monotonic `revision_id`
      - Lag alarm threshold at **4 seconds**

- **Milestone M1.1** — Landing zone provisioned and hardened *(week 3)*
- **Milestone M1.2** — Replica lag sustained under 4s for 72 hours *(week 6)*
- **Milestone M1.3** — Phase 1 exit review *(week 7)*

### Phase 2 — Shadow Traffic *(5 weeks)*

Owner: **Tobias Lindqvist**, SRE Manager

We mirror 100% of read traffic and 5% of synthetic write traffic to the new region. No customer sees a response from `eu-tarn-2` during this phase.

```python
# halyard/shadow_router.py — traffic mirroring decision logic
from dataclasses import dataclass

MIRROR_READ_PCT = 100
MIRROR_WRITE_PCT = 5

@dataclass
class Request:
    method: str
    tenant_id: str
    is_synthetic: bool

def should_mirror(req: Request, roll: int) -> bool:
    """Return True if the request is duplicated to eu-tarn-2."""
    if req.method in ("GET", "HEAD"):
        return roll < MIRROR_READ_PCT
    if not req.is_synthetic:
        return False  # never mirror real customer writes in Phase 2
    return roll < MIRROR_WRITE_PCT

if __name__ == "__main__":
    sample = Request(method="POST", tenant_id="halberd-004", is_synthetic=True)
    print(should_mirror(sample, roll=3))  # -> True
```

- **Milestone M2.1** — Shadow comparator reports <0.1% response divergence *(week 3)*
- **Milestone M2.2** — Chaos drill: region isolation for 20 minutes *(week 5)*

### Phase 3 — Progressive Cutover *(9 weeks)*

Owner: **Priya Raghunathan**

Traffic shifts in four steps, with a mandatory 5-business-day soak between each.

1. 5% of EU tenants
2. 25% of EU tenants
3. 100% of EU tenants
4. 20% of North American read traffic (latency experiment only)

- **Milestone M3.1** — First paying tenant served from `eu-tarn-2` *(week 2)*
- **Milestone M3.2** — ==Full EU residency compliance attested by Legal== *(week 7)*

### Phase 4 — Steady State and Decommission *(6 weeks)*

Owner: **Amara Ndiaye**

- Retire the single-region failover runbook (RB-114).
- Reduce `us-cascade-1` reserved capacity by 30%, saving an estimated **$41,800/month**.
- Publish the post-implementation review.

- **Milestone M4.1** — Cost reduction realized on the April invoice
- **Milestone M4.2** — PIR published and circulated *(week 6)*

---

## 3. Risk Register

| ID | Risk | Likelihood | Impact | Owner | Mitigation |
|----|------|-----------|--------|-------|------------|
| R-01 | Replication lag spikes during month-end billing runs | High | High | Dmitri Solokov | Throttle batch jobs; add a dedicated replication slot |
| R-02 | Cross-region write conflicts corrupt invoice totals | Medium | Critical | Tobias Lindqvist | Tenant-pinned write routing; nightly reconciliation job |
| R-03 | Budget for Phase 3 not approved by 1 May | Medium | High | Priya Raghunathan | Pre-brief the finance committee in April |
| R-04 | Key-person dependency on the Ravine replica tooling | High | Medium | Amara Ndiaye | Pair-rotation and a written operations guide by week 5 |
| R-05 | Legal attestation delayed past M3.2 | Low | High | Fenella Okoro | Start the review packet during Phase 2 |

*Risks are re-scored every second Thursday at the Halyard steering review.*

---

## 4. Governance

- **Cadence:** Weekly 30-minute working session; fortnightly steering committee.
- **Escalation path:** Team lead → Priya Raghunathan → Marcus Delacroix (VP Engineering).
- **Decision log:** All architectural decisions recorded as numbered ADRs in the `halyard-decisions` repository. ==No cutover step proceeds without a signed exit review.==
