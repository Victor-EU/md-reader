# Project Halyard — Status Report

**Reporting period:** Sprint 27 (Mar 3 – Mar 14)
**Owner:** Priya Venkataraman, Platform Engineering
**Status:** 🟡 On track with one risk

---

## Summary

Halyard's ingestion rewrite moved from staging to a 10% production canary on Tuesday. Tail latency improved sharply, but the replay service continues to leak file descriptors under sustained load.

> The canary held p99 under 200 ms through Thursday's traffic peak — the first time we've cleared that bar without shedding load.
> — Marcus Oyelaran, SRE on-call

## Metrics

| Metric | Sprint 26 | Sprint 27 | Target |
|---|---|---|---|
| p99 ingest latency | 412 ms | 187 ms | < 250 ms |
| Events/sec (sustained) | 44,000 | 71,500 | 60,000 |
| Error budget consumed | 38% | 21% | < 30% |
| Unit test coverage | 72.4% | 81.9% | 85% |

## Completed and Outstanding

- [x] Migrate `codec-v3` serialization to the shared buffer pool
- [x] Add backpressure signaling between shards
- [x] Publish canary dashboards to the Beacon workspace
- [ ] Fix descriptor leak in `replay-worker`
  - [x] Reproduce locally with the 6-hour soak harness
  - [ ] Patch and validate under load
- [ ] Draft runbook for shard rebalancing

## Architecture Notes

- Ingest tier
  - Shard router
    - Consistent hashing over `tenant_id`
    - Fallback to round-robin when a shard is quarantined
      - Quarantine expires after 90 seconds
  - Buffer pool (32 MiB slabs)
- Storage tier
  - Cold tier flush every 15 minutes

```python
def choose_shard(tenant_id: str, shards: list[str], quarantined: set[str]) -> str:
    healthy = [s for s in shards if s not in quarantined]
    if not healthy:
        raise RuntimeError("no healthy shards available")
    return healthy[hash(tenant_id) % len(healthy)]
```

## Next Steps

1. Land the descriptor-leak patch and run a 12-hour soak (due Mar 18).
2. Expand the canary to 35% of production traffic.
3. Raise coverage to 85% by backfilling tests on `shard_router`.
4. Schedule a design review for the rebalancing runbook with Storage.

**Ask:** one week of Dolores Kim's time for load-test tooling.
