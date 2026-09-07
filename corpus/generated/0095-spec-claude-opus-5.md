# Beacon Ledger Service — Technical Specification v0.4

**Status:** *Draft, internal review only.* Owner: Platform Reliability Guild.

## 1. Purpose

Beacon Ledger is an append-only event store for device telemetry checkpoints. It accepts signed checkpoint records from edge collectors and exposes a query surface for downstream reconciliation jobs.

> Design principle: a checkpoint that cannot be replayed deterministically is not a checkpoint — it is a rumor.

## 2. Functional Requirements

- **FR-1** Accept checkpoint batches of up to **512 records** or **1.8 MB**, whichever limit is reached first.
- **FR-2** Reject any record whose `emitted_at` timestamp drifts more than *90 seconds* from server clock.
- **FR-3** Guarantee idempotency via the `dedupe_key` field; duplicates return `202` with the original ledger offset.
- **FR-4** Support three retention tiers:
  - `hot` — 14 days, indexed
    - served from NVMe pool `bl-fast-01`
      - replication factor 3
      - ==compaction disabled in this tier==
  - `warm` — 120 days, partial index
  - `cold` — 5 years, object storage, no index

## 3. Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | p99 write latency | ≤ 45 ms |
| NFR-2 | Sustained ingest | 22,000 records/sec |
| NFR-3 | Availability | 99.95% monthly |

## 4. Delivery Checklist

- [x] Schema registry integration (`ledger.checkpoint.v2`)
- [x] Batch signature verification with Ed25519
- [ ] Cold-tier rehydration worker
- [ ] Per-tenant quota enforcement
- [x] Structured audit log emitter

## 5. API Sketch

```http
POST /v1/ledgers/{ledger_id}/checkpoints
Content-Type: application/json
X-Collector-Signature: ed25519:9f4c2ab7

{
  "batch_id": "btc-70ff31",
  "records": [
    {
      "dedupe_key": "dev-4471:seq-90218",
      "device_id": "dev-4471",
      "emitted_at": "2031-03-09T14:22:07Z",
      "tier_hint": "hot",
      "payload": { "voltage": 11.94, "faults": 0 }
    }
  ]
}
```

Successful writes return `201` with `{ "offset": 8812440, "tier": "hot" }`. Oversized batches return `413`; clock drift violations return `422` with error code `DRIFT_EXCEEDED`.
