# Tessera Ingest Service — Technical Specification v0.4

**Status:** Draft for review · **Owner:** Platform Data Group · **Last revision:** 2024-11-08

Tessera is an internal ingest gateway that accepts semi-structured telemetry envelopes from edge collectors, normalizes them against a registered schema, and forwards accepted records to the `hallway.events` stream. This document defines the functional requirements, non-functional targets, and the public HTTP surface for the v1 API.

> Tessera is deliberately *not* a storage system. Any request that implies retention beyond the 90-second replay buffer must be rejected at the edge rather than silently absorbed.

## 1. Scope and Definitions

- **Envelope** — a JSON object containing exactly one `payload` and one `meta` block.
- **Collector** — an authenticated client process identified by a `collector_id` of the form `col-<6 hex>`.
- **Normalization** — the process of coercing payload fields to the types declared in the bound schema version.

## 2. Functional Requirements

1. The service **MUST** validate every envelope against the schema version named in `meta.schema_ref` before any forwarding occurs.
2. The service **MUST** reject envelopes larger than **512 KiB** with HTTP `413`.
3. The service **SHOULD** support batched submission of up to 200 envelopes per request.
4. Rejected envelopes **MUST** be written to the quarantine topic with the original bytes preserved verbatim.
5. Replay requests **MAY** be served from the in-memory buffer; if the requested offset has expired, the service returns `410 Gone`.

### 2.1 Validation Rules

- Type coercion
  - Numeric fields
    - Integers wider than 53 bits are ==rejected, not truncated==.
    - Floating point `NaN` and `Infinity` are rejected.
    - Fixed-point decimals are accepted as strings only.
  - Temporal fields
    - Timestamps must be RFC 3339 with an explicit offset.
    - Durations are expressed in whole milliseconds.
- Field cardinality
  - Arrays are capped at 1,024 elements.

## 3. Non-Functional Targets

| Metric | Target |
|---|---|
| p50 accept latency | ≤ 9 ms |
| p99 accept latency | ≤ 74 ms |
| Sustained throughput | 18,000 envelopes/sec per node |
| Availability | 99.95% monthly |

Latency is measured from *first byte received* to *acknowledgment written*, excluding downstream stream commit.

## 4. API Sketch

```http
POST /v1/envelopes HTTP/1.1
Host: tessera.internal
Authorization: Bearer <collector-token>
Content-Type: application/json

{
  "meta": {
    "collector_id": "col-4af92c",
    "schema_ref": "sensor.thermal/3",
    "emitted_at": "2024-11-08T14:02:11.480+00:00"
  },
  "payload": {
    "probe": "north-riser-2",
    "celsius": 41.75,
    "sample_window_ms": 500
  }
}
```

Successful acceptance returns `202 Accepted` with a body containing `ingest_id` and `buffer_offset`. Validation failures return `422` with a `violations` array; each entry carries a JSON Pointer, a rule code (for example `TSR-1104`), and a human-readable hint.

### 4.1 Endpoint Summary

- `POST /v1/envelopes` — single or batched submission
- `GET /v1/schemas/{name}/{version}` — retrieve a bound schema document
- `GET /v1/replay?offset=<n>&limit=<n>` — read from the replay buffer
- `DELETE /v1/quarantine/{ingest_id}` — purge a quarantined record (admin scope)

## 5. Delivery Checklist

- [x] Schema registry client with local cache
- [x] Envelope size guard and streaming parser
- [x] Quarantine writer with byte-preserving encoder
- [ ] Batch endpoint with partial-success semantics
- [ ] Replay buffer eviction metrics
- [ ] Admin scope enforcement for `DELETE /v1/quarantine`

## 6. Open Questions

Whether batch submissions should fail atomically or per-item remains **unresolved**. The current prototype fails the entire batch, which simplifies client retry logic but wastes bandwidth when a single malformed record is present.
