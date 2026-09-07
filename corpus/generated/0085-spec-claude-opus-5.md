# Halyard Ingest Service — Technical Specification v0.4

**Status:** Draft for review
**Owner:** Platform Data Group (team handle `pdg-halyard`)
**Last revised:** cycle 2027.Q1, week 6
**Supersedes:** v0.3 (deprecated on merge of RFC-812)

---

## 1. Purpose and Scope

Halyard is an internal ingest service that accepts semi-structured telemetry from field devices, normalizes it against a versioned schema registry, and emits canonical records onto the `ledger.events` topic for downstream consumers.

This document specifies the external HTTP and gRPC surfaces, the durability guarantees, and the operational thresholds Halyard must satisfy before promotion from `staging-brackish` to `prod-northwind`.

**Out of scope:** the schema authoring workflow (see the Marlin Registry spec), long-term cold storage tiering, and the device-side agent (`spar-agent`) which is documented separately.

> Halyard is deliberately *not* a general-purpose message broker. It performs exactly three jobs — authenticate, normalize, and durably hand off. Any feature request that adds routing logic, fan-out policy, or per-consumer filtering belongs to the Cormorant dispatcher, not here.

---

## 2. Definitions

- **Batch** — an ordered collection of 1 to 512 envelopes submitted in a single request.
- **Envelope** — a single measurement payload plus its device metadata header.
- **Normalization pass** — the deterministic transformation from envelope to canonical record using a pinned schema revision.
- **Quarantine** — the durable holding area for envelopes that fail normalization but were accepted at the transport layer.
- **Handoff receipt** — the acknowledgment token returned once a batch has been committed to the write-ahead log on at least two replicas.

---

## 3. Functional Requirements

1. **REQ-101 — Batch acceptance.** The service *must* accept batches over HTTP/2 (`POST /v1/batches`) and gRPC (`Halyard.SubmitBatch`). Both surfaces must produce byte-identical canonical records for equivalent input.
2. **REQ-102 — Idempotency.** Every batch carries a client-generated `batch_key` (opaque, 16–64 bytes). Replays of the same `batch_key` within a **72-hour** window must return the original handoff receipt without re-emitting records.
3. **REQ-103 — Schema pinning.** Each envelope declares `schema_ref` in the form `namespace/name@revision`. Unpinned or wildcard revisions are rejected with `SCHEMA_UNPINNED`.
4. **REQ-104 — Partial batch outcomes.** A batch containing both valid and invalid envelopes must commit the valid ones and quarantine the rest. The response reports per-envelope status. ==A batch is never rejected wholesale merely because a subset of envelopes failed normalization.==
5. **REQ-105 — Ordering.** Records originating from the same `device_id` must be emitted in the order the client submitted them within a batch. Cross-batch ordering is *not* guaranteed and clients must not depend on it.
6. **REQ-106 — Clock skew tolerance.** Envelopes with `observed_at` more than **900 seconds** in the future relative to service time are quarantined with `CLOCK_SKEW_FORWARD`. Backdating is permitted up to **30 days**.
7. **REQ-107 — Quarantine retrieval.** Quarantined envelopes must remain retrievable via `GET /v1/quarantine` for **14 days**, after which they are purged and only a counter aggregate survives.
8. **REQ-108 — Credential scoping.** A device token grants write access to exactly one `fleet_id`. Cross-fleet submission returns `403 FLEET_MISMATCH` and increments the `halyard.auth.cross_fleet` counter.

---

## 4. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-201 | p50 handoff latency, 64-envelope batch | ≤ 34 ms |
| NFR-202 | p99 handoff latency, 64-envelope batch | ≤ 210 ms |
| NFR-203 | Sustained ingest throughput per node | ≥ 18,000 envelopes/s |
| NFR-204 | Durability after receipt | 2-replica WAL commit, RPO 0 |
| NFR-205 | Availability (rolling 30 days) | 99.95% |
| NFR-206 | Max envelope size | 96 KiB uncompressed |
| NFR-207 | Max batch size | 6 MiB compressed |
| NFR-208 | Cold start to first accepted batch | ≤ 4.5 s |

Rate limiting is applied per `fleet_id` using a leaky bucket with a burst capacity of **2,400 envelopes** and a drain rate of **600 envelopes/s**. Exceeding the bucket yields `429` with a `Retry-After` header expressed in whole seconds.

---

## 5. API Sketch

### 5.1 Submit a batch

```http
POST /v1/batches HTTP/2
Host: halyard.internal
Authorization: Bearer <device-token>
Content-Type: application/json
Content-Encoding: zstd
X-Halyard-Batch-Key: b7f2c1de9a4058ee

{
  "fleet_id": "fl_thornwick_04",
  "submitted_at": "2027-02-11T09:14:03.221Z",
  "envelopes": [
    {
      "device_id": "dv_09aa31",
      "schema_ref": "marine/hull_strain@7",
      "observed_at": "2027-02-11T09:13:58.004Z",
      "sequence": 918342,
      "payload": {
        "strain_micro": 412.77,
        "sensor_slot": "port-aft-3",
        "temp_c": -1.8
      }
    },
    {
      "device_id": "dv_09aa31",
      "schema_ref": "marine/hull_strain@7",
      "observed_at": "2027-02-11T09:13:59.010Z",
      "sequence": 918343,
      "payload": {
        "strain_micro": 409.02,
        "sensor_slot": "port-aft-3",
        "temp_c": -1.9
      }
    }
  ]
}
```

**Success response — `202 Accepted`:**

```json
{
  "receipt": "rcpt_4KQ2n8vTzLp",
  "batch_key": "b7f2c1de9a4058ee",
  "committed": 2,
  "quarantined": 0,
  "replay": false,
  "results": [
    { "index": 0, "status": "COMMITTED", "record_id": "rec_01HQ8ZK3M2" },
    { "index": 1, "status": "COMMITTED", "record_id": "rec_01HQ8ZK3M3" }
  ]
}
```

**Partial outcome — `207 Multi-Status`:**

```json
{
  "receipt": "rcpt_9XmT4bQdWr1",
  "committed": 1,
  "quarantined": 1,
  "replay": false,
  "results": [
    { "index": 0, "status": "COMMITTED", "record_id": "rec_01HQ8ZM7B1" },
    {
      "index": 1,
      "status": "QUARANTINED",
      "reason": "FIELD_TYPE_MISMATCH",
      "detail": "payload.temp_c expected number, received string",
      "quarantine_id": "qn_5518aa20"
    }
  ]
}
```

### 5.2 Fetch a receipt

```
GET /v1/receipts/{receipt_id}
```

Returns the stored outcome for **72 hours**. After expiry, returns `410 Gone` with body `{"code":"RECEIPT_EXPIRED"}`.

### 5.3 List quarantined envelopes

```
GET /v1/quarantine?fleet_id=fl_thornwick_04&since=2027-02-10T00:00:00Z&limit=100&cursor=<opaque>
```

Response fields: `items[]`, `next_cursor`, `total_estimate`. The `total_estimate` is a sketch-based approximation and *may drift by up to 3%* under heavy write load; do not use it for reconciliation.

### 5.4 Replay a quarantined envelope

```
POST /v1/quarantine/{quarantine_id}/replay
{ "schema_ref_override": "marine/hull_strain@8" }
```

Replay attempts normalization again, optionally against a newer schema revision. On success the envelope transitions to `COMMITTED` and the quarantine entry is tombstoned. On repeated failure, `failure_count` increments; after **5** failures the entry is locked and further replays return `409 REPLAY_LOCKED`.

### 5.5 Health and readiness

- `GET /healthz` — liveness only, no dependency checks, always cheap.
- `GET /readyz` — verifies WAL writability, registry cache freshness (< 90 s), and broker connectivity.

### 5.6 Error codes

| Code | HTTP | Retryable |
|---|---|---|
| `SCHEMA_UNPINNED` | 400 | no |
| `SCHEMA_NOT_FOUND` | 400 | no |
| `FIELD_TYPE_MISMATCH` | 422 | no |
| `CLOCK_SKEW_FORWARD` | 422 | no |
| `FLEET_MISMATCH` | 403 | no |
| `BATCH_TOO_LARGE` | 413 | no |
| `RATE_LIMITED` | 429 | yes |
| `WAL_UNAVAILABLE` | 503 | yes |
| `REGISTRY_STALE` | 503 | yes |

---

## 6. Normalization Pipeline

The pass is deterministic and side-effect free. Given identical input bytes and an identical pinned schema revision, it must produce identical canonical output — this property is enforced by a nightly differential job (`halyard-determinism-sweep`) that replays a 50,000-envelope corpus against the current build.

Stages, in order:

1. **Decode** — decompress, parse, and reject on malformed framing before any allocation of payload buffers.
2. **Header validation** — check `device_id` format, `sequence` monotonicity hints, and timestamp bounds.
3. **Schema resolution** — fetch the pinned revision from the local registry cache; on miss, perform a blocking fetch with a **250 ms** budget.
4. **Coercion** — apply the schema's declared coercion table (e.g. integer-to-float widening). *Narrowing coercions are always rejected.*
5. **Enrichment** — attach `fleet_id`, ingest timestamp, and the resolving schema fingerprint.
6. **Canonical encode** — serialize to the columnar canonical form and compute a content hash for dedupe.

---

## 7. Delivery Checklist

- [x] HTTP surface for `POST /v1/batches` implemented behind flag `halyard.http.v1`
- [x] WAL two-replica commit path with fsync barrier
- [x] Idempotency store backed by the `saltmarsh` key-value tier
- [x] Per-fleet leaky bucket rate limiter
- [x] Determinism sweep job scheduled nightly at 02:40 UTC
- [ ] gRPC surface parity (`Halyard.SubmitBatch`, `Halyard.FetchReceipt`)
- [ ] Quarantine replay lock semantics and `failure_count` persistence
- [ ] Registry cache warm-on-boot to satisfy NFR-
