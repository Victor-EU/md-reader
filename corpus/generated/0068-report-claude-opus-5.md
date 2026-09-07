# Project Halyard — Status Report

**Reporting period:** March 3 – March 14, 2025
**Owner:** Priya Raghunathan, Platform Engineering
**Status:** ==At risk — schedule slip of 6 working days on the migration track==

---

## 1. Executive Summary

Halyard replaces our legacy batch ingestion service (`corvid-loader`) with a streaming pipeline built on the internal Tidewater event bus. Throughput and correctness targets for Phase 2 have been met ahead of plan, but the **cutover of tenant shard `eu-central-b`** slipped after we discovered schema drift in three downstream consumers. We are recommending a *two-week hardening window* before Phase 3 begins.

---

## 2. Metrics

| Metric | Target | Last period | This period | Trend |
|---|---|---|---|---|
| Median ingest latency (p50) | ≤ 400 ms | 610 ms | **312 ms** | ▲ |
| Tail latency (p99) | ≤ 2.0 s | 4.8 s | 2.4 s | ▲ |
| Records processed / day | 900 M | 740 M | 1.02 B | ▲ |
| Duplicate emission rate | < 0.01 % | 0.19 % | 0.004 % | ▲ |
| Dead-letter queue depth (avg) | < 500 | 3,140 | 812 | ▲ |
| Unit + integration coverage | 80 % | 71 % | 76 % | ▲ |
| Open Sev-2 defects | 0 | 5 | 3 | ▬ |
| Monthly infra cost | $48 K | $61 K | $52 K | ▲ |

Cost reduction came almost entirely from retiring the `corvid-loader` warm standby fleet in `us-west-2`.

---

## 3. What Shipped

- **Exactly-once sink adapter** (`halyard-sink v0.9.3`)
  - Idempotency keys derived from `(tenant_id, source_offset, schema_hash)`
  - Rollback path validated against three failure modes:
    - Broker partition reassignment mid-commit
    - Sink database failover
      - *Primary → replica promotion under 12 s* — passed
      - *Split-brain simulation* — **failed once**, fix merged in PR #2214
- **Backfill tooling** for historical replay windows up to 90 days
- Observability: 14 new dashboards, 9 alert rules, ==one paging rule retired as noisy==

---

## 4. Reference Implementation

The consumer contract check that caught the drift now runs in CI:

```python
def validate_contract(payload: dict, contract: Contract) -> list[str]:
    """Return a list of human-readable drift findings."""
    findings = []
    for field, spec in contract.fields.items():
        if field not in payload:
            if spec.required:
                findings.append(f"missing required field: {field}")
            continue
        actual = type(payload[field]).__name__
        if actual != spec.type_name:
            findings.append(
                f"{field}: expected {spec.type_name}, saw {actual}"
            )
    unknown = set(payload) - set(contract.fields)
    if unknown and contract.strict:
        findings.append(f"unexpected fields: {sorted(unknown)}")
    return findings
```

---

## 5. Risks

1. **Schema drift in downstream consumers** — *high likelihood, high impact*
   - Owner: Devon Okafor
   - Mitigation: contract tests gated in CI as of March 11
2. **Backfill contention with nightly reporting jobs** — *medium / medium*
   - Mitigation: throttle backfill to 30 % of broker capacity between 01:00–05:00 UTC
3. Staffing: one engineer rotates off March 28

---

## 6. Next Steps

| # | Action | Owner | Due |
|---|---|---|---|
| 1 | Land split-brain fix and re-run chaos suite | M. Villareal | Mar 19 |
| 2 | Cut over `eu-central-b` shard | P. Raghunathan | Mar 24 |
| 3 | Publish consumer migration guide (v2 contracts) | D. Okafor | Mar 26 |
| 4 | Raise coverage to 80 % | S. Lindqvist | Apr 2 |
| 5 | Phase 3 scoping review with Data Platform | P. Raghunathan | Apr 4 |

**Decision requested:** approval for the hardening window. Without it, Phase 3 begins on top of *three known Sev-2 defects*, which we do not recommend.
