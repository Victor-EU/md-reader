# Project Meridian — Engineering Status Report

**Reporting period:** 14 Apr – 27 Apr (Sprints 19–20)
**Prepared by:** Dana Whitcomb, Technical Program Lead
**Distribution:** Platform Steering Group, Data Reliability, Client SDK Guild, Finance Partner (S. Okonjo)
**Overall status:** 🟡 **Amber** — schedule risk on the multi-region cutover; all other workstreams green

---

## 1. Executive Summary

Meridian replaces the legacy `ingest-monolith` with a horizontally partitioned event pipeline built around the Halyard gateway, the Tidewater stream processor, and the Cairn schema registry. The goal is to sustain 500k events/second at a p99 end-to-end latency under 150 ms while cutting steady-state infrastructure spend by at least 30%.

During this reporting period we completed the shadow-traffic phase for all seven tenant classes and promoted Tidewater to primary for 62% of production volume. Throughput and latency targets are being met comfortably in single-region operation. The Amber status is driven entirely by the **multi-region failover work (WS-4)**, which slipped 11 working days after we discovered that the shard rebalancer produces duplicate partition assignments during a split-brain recovery. A fix is designed and partially implemented; we expect to recover roughly half the slip by the end of Sprint 22.

No customer-visible incidents were attributable to Meridian this period. One Sev-3 (INC-2291) was raised against the legacy path and is unrelated.

---

## 2. Status at a Glance

| Dimension | Target | Current | Trend | Status |
|---|---|---|---|---|
| Production traffic on new pipeline | 100% by 12 Jun | 62% | ▲ +23 pts | 🟢 |
| Sustained throughput (peak hour) | 500k ev/s | 412k ev/s | ▲ +58k | 🟢 |
| End-to-end p99 latency | ≤ 150 ms | 87 ms | ▼ −19 ms | 🟢 |
| Error budget consumed (30d) | ≤ 100% | 41% | ▬ flat | 🟢 |
| Monthly infra run rate | ≤ $104k | $118k | ▼ −$16k | 🟡 |
| Line coverage, core services | ≥ 80% | 78.4% | ▲ +2.1 pts | 🟡 |
| Open Sev-1/Sev-2 defects | 0 | 0 | ▬ | 🟢 |
| Multi-region failover drill passed | Yes by 09 May | No | — | 🔴 |

---

## 3. Progress Against Milestones

| ID | Milestone | Baseline date | Forecast | Variance |
|---|---|---|---|---|
| M-07 | Shadow traffic, all tenant classes | 18 Apr | 17 Apr | −1 d |
| M-08 | 50% production cutover | 25 Apr | 24 Apr | −1 d |
| M-09 | Region-pair failover drill | 09 May | 24 May | **+11 d** |
| M-10 | 100% production cutover | 12 Jun | 12 Jun | 0 d |
| M-11 | Legacy decommission, cost realized | 30 Jun | 08 Jul | +6 d |

M-09 is the critical path item. M-10 retains its date only because the cutover ramp can proceed in single-region mode for tenant classes A–E; classes F and G (regulated workloads) contractually require a demonstrated failover before migration, so any further slip on M-09 propagates directly to M-10 and M-11.

---

## 4. Key Metrics

### 4.1 Throughput and Latency

Measured at the Halyard ingress edge through to durable commit in the Tidewater log, sampled at one-minute resolution over the trailing 14 days.

| Metric | Sprint 18 | Sprint 19 | Sprint 20 | Target |
|---|---|---|---|---|
| Median throughput (ev/s) | 198,400 | 246,900 | 291,300 | — |
| Peak-hour throughput (ev/s) | 291,000 | 354,000 | 412,000 | 500,000 |
| p50 latency (ms) | 21 | 19 | 18 | — |
| p99 latency (ms) | 132 | 106 | 87 | ≤ 150 |
| p99.9 latency (ms) | 604 | 441 | 312 | ≤ 750 |
| Ingest rejection rate | 0.084% | 0.061% | 0.037% | ≤ 0.05% |

The p99.9 improvement is largely attributable to the compaction scheduler change landed in `tidewater-core@2.14.0`, which stopped compaction from competing with append-path fsyncs on the same NVMe queue. We also removed a synchronous Cairn lookup from the hot path by caching resolved schema fingerprints for 90 seconds; that alone accounted for an estimated 14 ms of p99.

### 4.2 Reliability

- Availability (successful ingest / total ingest attempts, 30-day window): **99.981%** against a 99.95% objective.
- Error budget consumed: **41%** of the 30-day allowance.
- Mean time to detect (synthetic canary): **48 seconds**, down from 3 m 10 s after the Lantern alert-routing rework.
- Mean time to recover, non-paging degradations: **11 minutes** (n = 6).
- Data loss events: **0**. Duplicate-delivery events: **3**, all within the at-least-once contract and absorbed by downstream idempotency keys.

### 4.3 Cost

| Component | Legacy monthly | Meridian at 62% | Projected at 100% |
|---|---|---|---|
| Compute (gateway + processors) | $61,200 | $38,400 | $47,900 |
| Storage (hot log + tiered) | $44,800 | $29,100 | $33,600 |
| Cross-AZ / cross-region transfer | $27,500 | $16,900 | $19,200 |
| Observability and telemetry | $14,300 | $9,800 | $11,400 |
| **Total** | **$147,800** | **$94,200** | **$112,100** |

Projected steady state is $112.1k against a $104k target — an $8.1k monthly gap. Roughly $5.6k of that is telemetry cardinality we have not yet trimmed; the remainder is over-provisioned processor headroom that we intend to reclaim once autoscaling policies have 30 days of production signal. Note the transitional period carries **both** stacks, so April's blended spend is $206k. Finance has been briefed and the double-run cost is inside the approved $340k transition envelope.

### 4.4 Engineering Quality

- Line coverage across `halyard`, `tidewater-core`, `cairn`: **78.4%** (target 80%).
- Mutation score on the partition-assignment package: **64%** — the lowest in the codebase and directly relevant to the WS-4 defect.
- Mean PR review time: **6.1 hours** (down from 9.4).
- Flaky test rate: **1.7%** of CI runs, from 4.3% two sprints ago.
- Open defects: 0 Sev-1, 0 Sev-2, 14 Sev-3, 39 Sev-4.

---

## 5. Workstream Detail

- **WS-1 — Halyard ingress gateway** — 🟢 *On track (94% complete)*
  - Protocol support
    - gRPC bidirectional streaming — complete
    - HTTP/2 batch endpoint — complete
    - Legacy TCP framing shim — complete, deprecation notice scheduled for 15 May
  - Admission control
    - Per-tenant token buckets — complete
    - Adaptive credit-based backpressure — in progress
      - Controller implementation — merged
      - Tuning against tenant class C burst profile — **open**, owner: M. Oyelaran
      - Runbook and dashboards — not started
- **WS-2 — Tidewater stream processor** — 🟢 *On track (88% complete)*
  - Append path
    - Segment writer with group commit — complete
    - Compaction scheduler decoupling — complete
  - Read path
    - Consumer group coordination — complete
    - Replay from arbitrary offset — complete
    - Tiered-storage fetch
      - Warm tier (local SSD) — complete
      - Cold tier (object store) — in progress
        - Range-read coalescing — merged
        - Prefetch heuristics — **open**, owner: I. Farkas
- **WS-3 — Cairn schema registry** — 🟢 *On track (100% complete)*
  - Compatibility enforcement, fingerprint caching, and bulk import all shipped in Sprint 19.
- **WS-4 — Multi-region failover** — 🔴 *At risk (46% complete)*
  - Replication transport — complete
  - Shard rebalancer
    - Steady-state assignment — complete
    - Recovery from partial partition — **defective**, see §6
      - Fencing token design — approved 22 Apr
      - Implementation — 60% complete
      - Chaos test suite — not started
  - Failover drill run
