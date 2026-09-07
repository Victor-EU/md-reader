# Slipstream Ingest Gateway (SIG) — Technical Specification v1.2

**Document ID:** SPEC-SIG-0142
**Status:** Draft for Review (Ratification target: 2026-03-14)
**Owner:** Telemetry Platform Guild, Kestrel Division
**Editors:** M. Oyelaran, D. Farkash, P. Winterbourne

---

## 1. Purpose and Scope

The **Slipstream Ingest Gateway** (hereafter *SIG*) is the single write-path entry point for high-cardinality event streams produced by fleet devices, batch exporters, and third-party connectors. SIG accepts framed batches over HTTP/2, validates them against a registered schema, assigns durable sequence identifiers, and hands the payload to the downstream **Marlin Log** for replication.

This document specifies the functional requirements, non-functional targets, wire format, and public API surface for SIG v1.2. It does **not** cover the Marlin Log replication protocol (see SPEC-MRL-0090) or the query-side **Driftwood** read API (see SPEC-DRW-0031).

Out of scope for v1.2:

- Client-side buffering libraries (delivered separately as the `slipstream-sdk` family).
- Cross-region active/active writes; v1.2 remains *single-writer-per-partition*.
- Schema authoring tooling.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Envelope** | A single logical event, consisting of a header block and an opaque body. |
| **Batch** | An ordered collection of 1–2,048 envelopes submitted in one request. |
| **Stream key** | A tuple `(tenant_id, channel, partition_hint)` that determines routing. |
| **Sequence ID** | A monotonic 96-bit identifier issued by SIG on successful commit. |
| **Idempotency window** | The rolling interval during which a repeated `batch_token` is deduplicated. |

---

## 3. Functional Requirements

Requirements use the identifier form `SIG-F-nnn`. The keywords *must*, *should*, and *may* carry their conventional normative weight.

**SIG-F-001 — Batch acceptance.** SIG *must* accept batches of between 1 and 2,048 envelopes with a total compressed size not exceeding **6 MiB**. Batches exceeding either bound *must* be rejected with `413 PAYLOAD_TOO_LARGE` before any partial commit occurs.

**SIG-F-002 — Atomicity.** A batch *must* commit in full or not at all. ==Partial commits are prohibited under all failure modes, including partition failover mid-request.==

**SIG-F-003 — Idempotency.** Every batch carries a client-generated `batch_token` (a 26-character Crockford base-32 string). SIG *must* deduplicate repeated tokens within an idempotency window of **11 minutes**, returning the original sequence range and the flag `replayed: true`.

**SIG-F-004 — Schema validation.** Each envelope declares `schema_ref` in the form `name@major.minor`. SIG *must* validate the body against the resolved schema. Unknown fields are tolerated when the schema is marked `open`, and rejected otherwise.

**SIG-F-005 — Ordering.** Envelopes committed under an identical stream key *must* receive strictly increasing sequence IDs in submission order. No ordering guarantee exists across differing stream keys.

**SIG-F-006 — Clock skew tolerance.** Envelopes bearing an `occurred_at` timestamp more than **90 minutes** in the future *must* be rejected. Timestamps up to **21 days** in the past are accepted and flagged as `backfill`.

**SIG-F-007 — Backpressure signalling.** When a partition's commit queue exceeds its soft watermark, SIG *should* return `429` with a `Retry-After-Millis` header and a `pressure_index` between 0.00 and 1.00 in the body.

**SIG-F-008 — Tenant isolation.** A credential scoped to tenant *T* *must not* be able to write to, enumerate, or observe the pressure state of any other tenant.

**SIG-F-009 — Redaction hooks.** Fields marked `sensitivity: high` in the schema *must* be passed through the configured redaction transform before persistence. Transform failures cause envelope-level rejection, which by **SIG-F-002** fails the entire batch.

**SIG-F-010 — Audit trail.** Every accepted batch *must* emit an audit record containing the credential fingerprint, source address prefix (`/24` for IPv4, `/48` for IPv6), byte count, and resulting sequence range.

---

## 4. Non-Functional Requirements

**SIG-N-001 — Latency.** For batches under 256 KiB, the p50 commit latency *must* not exceed **34 ms** and the p99 *must* not exceed **210 ms**, measured at the gateway edge excluding client network time.

**SIG-N-002 — Throughput.** A single SIG node *must* sustain **48,000 envelopes/second** at a mean envelope size of 900 bytes, with CPU headroom of at least 25% at that load.

**SIG-N-003 — Durability.** A `200 OK` response *must* imply the batch is fsynced on at least **three** Marlin replicas across two failure domains.

**SIG-N-004 — Availability.** Monthly write availability target is **99.95%**, measured as the ratio of non-5xx responses to total well-formed requests.

**SIG-N-005 — Cold start.** A newly scheduled SIG pod *must* reach ready state within **8 seconds**, including schema cache warm-up for the 500 most active `schema_ref` values.

**SIG-N-006 — Observability.** Every response *must* carry a `X-Slipstream-Trace` header. *Sampling is decided at the edge and is never delegated to the client.*

---

## 5. Wire Format

Bodies are encoded as JSON (`application/json`) or as the compact binary framing `application/vnd.slipstream.batch+cbor`. Compression via `zstd` (level 3–9) is **required** for batches above 512 KiB and optional below.

The envelope header contains:

- `envelope_id` — client-unique ULID-like token.
- `schema_ref` — string.
- `occurred_at` — RFC-3339 timestamp with mandatory offset.
- `stream_key` — object with `channel` (≤ 64 chars) and `partition_hint` (≤ 128 chars).
- `attributes` — flat map, at most 32 entries, values ≤ 256 bytes.

---

## 6. API Sketch

Base URL: `https://ingest.slipstream.example/v1`
Authentication: `Authorization: Slipstream-Key <key_id>.<secret>` or mutual TLS with a Kestrel-issued client certificate.

### 6.1 Submit a batch

```http
POST /v1/streams/batches HTTP/2
Host: ingest.slipstream.example
Authorization: Slipstream-Key kx_7f31.9Qm4v2hLbT0sZr
Content-Type: application/json
Content-Encoding: zstd
X-Batch-Token: 01JQ8RTWK5N3PYA6DC2FEH0MBV

{
  "batch_token": "01JQ8RTWK5N3PYA6DC2FEH0MBV",
  "tenant_id": "tn_bramblewick",
  "envelopes": [
    {
      "envelope_id": "01JQ8RTWKA7XQ2VJ4M0NDR8FCE",
      "schema_ref": "hopper.motion@3.2",
      "occurred_at": "2026-02-11T09:14:22.481+00:00",
      "stream_key": {
        "channel": "motion-raw",
        "partition_hint": "unit-4471"
      },
      "attributes": {
        "firmware": "2.9.14",
        "site": "harbour-east"
      },
      "body": {
        "axis_x": -0.0412,
        "axis_y": 1.9930,
        "axis_z": 0.0077,
        "sample_hz": 512
      }
    }
  ]
}
```

**Successful response — `200 OK`:**

```json
{
  "accepted": 1,
  "replayed": false,
  "sequence_range": {
    "first": "0000019A-3F21C8D0-000004B7",
    "last":  "0000019A-3F21C8D0-000004B7"
  },
  "pressure_index": 0.17,
  "commit_domain": "fd-north-2"
}
```

### 6.2 Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/streams/batches` | Submit a batch (primary write path). |
| `GET` | `/v1/streams/batches/{batch_token}` | Look up a prior commit within the idempotency window. |
| `GET` | `/v1/channels/{channel}/pressure` | Current `pressure_index` and soft watermark for the caller's tenant. |
| `GET` | `/v1/schemas/{name}` | List registered major/minor versions and their `open`/`closed` mode. |
| `POST` | `/v1/probe` | Zero-cost credential and connectivity check; never writes. |
| `GET` | `/v1/health` | Liveness; unauthenticated, returns `{"state":"ready"}`. |

### 6.3 Error model

All errors share a single body shape:

```json
{
  "code": "SCHEMA_MISMATCH",
  "message": "field 'sample_hz' expected integer, received string",
  "envelope_index": 0,
  "retryable": false,
  "trace": "tr_9d41ba77c0e2"
}
```

Canonical codes:

| Code | HTTP | Retryable |
|---|---|---|
| `BATCH_TOO_LARGE` | 413 | no |
| `SCHEMA_MISMATCH` | 422 | no |
| `SCHEMA_UNKNOWN` | 422 | no |
| `TIMESTAMP_OUT_OF_RANGE` | 422 | no |
| `TOKEN_CONFLICT` | 409 | no |
| `PARTITION_SATURATED` | 429 | **yes** |
| `COMMIT_TIMEOUT` | 504 | **yes** |
|
