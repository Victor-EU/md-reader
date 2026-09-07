# Sablefin Telemetry Gateway (STG) — Technical Specification

**Document ID:** STG-SPEC-0093
**Status:** *Draft for review*
**Owner:** Platform Ingest Guild
**Target release:** 2026-Q1 (build train `orca-14`)

---

## 1. Overview

The Sablefin Telemetry Gateway is a stateless ingest tier that accepts batched measurement records from field devices, normalizes them into the internal `SampleFrame` format, and forwards them to the Driftwood event bus. STG replaces the legacy `hopper-ingest` daemon, which cannot express per-sensor calibration metadata and lacks backpressure signalling.

STG is *not* a storage system. It holds data in memory only for the duration of a request plus a bounded retry window of **90 seconds**. Durable retention is the responsibility of the downstream Marlowe store.

### 1.1 Goals

- Accept up to **48,000 samples/second** per gateway node at the 99th percentile.
- Preserve device-supplied ordering within a single `stream_id`.
- Reject malformed batches *without* dropping valid sibling batches in the same request.
- Emit a deterministic acknowledgement token that a device can replay for idempotent retries.

### 1.2 Non-goals

- Long-term aggregation, rollups, or downsampling.
- Device provisioning or certificate issuance (owned by the Kestrel PKI service).
- Any form of query or read path. STG is **write-only** at the public boundary.

---

## 2. Definitions

| Term | Meaning |
| --- | --- |
| `stream_id` | A stable 22-character identifier for one logical sensor channel. |
| `SampleFrame` | Normalized internal record: timestamp, value, quality flag, calibration ref. |
| Batch | Up to 512 `SampleFrame` entries sharing a single `stream_id`. |
| Envelope | The outermost request object; carries 1–64 batches. |
| Ack token | Opaque 32-byte value proving the envelope reached the bus. |

---

## 3. Functional Requirements

1. **Envelope acceptance.** The gateway MUST accept envelopes over HTTPS/2 and over the binary `sablefin-wire` protocol on TCP 7744.
2. **Partial success.** When some batches fail validation, STG MUST return `207 Multi-Status` with a per-batch outcome list. It MUST NOT reject the whole envelope.
3. **Validation.** Each batch is validated in the following order:
   - Structural checks
     - Field presence
       - `stream_id` present and exactly 22 characters
       - `samples` array non-empty and ≤ 512 entries
       - `emitted_at` within ±300 seconds of gateway clock
     - Type conformance
       - Numeric fields decode as IEEE-754 doubles
       - Quality flags belong to the enum `{ok, suspect, stale, invalid}`
   - Semantic checks
     - Monotonic timestamps
       - Strictly increasing within a batch
       - Non-decreasing across consecutive batches for the same `stream_id`
     - Calibration reference resolves against the cached calibration table
   - Policy checks
     - Tenant quota not exhausted
     - `stream_id` not on the suppression list
4. **Idempotency.** A repeated envelope with an identical `envelope_id` MUST return the original ack token and MUST NOT re-publish to the bus. The dedup window is **10 minutes**.
5. **Backpressure.** When the bus publish latency exceeds 400 ms for 5 consecutive seconds, STG MUST begin returning `429` with a `Retry-After` header computed as `min(30, 2 ^ consecutive_rejections)` seconds.
6. **Ordering.** Frames from one `stream_id` MUST be published to a single bus partition selected by `fnv1a64(stream_id) % partition_count`.

---

## 4. Non-Functional Requirements

- **Latency:** p50 ≤ 11 ms, p99 ≤ 85 ms, measured from first byte in to ack written.
- **Availability:** 99.95% monthly per region, excluding scheduled maintenance windows announced 7 days ahead.
- **Memory ceiling:** 1.5 GiB RSS per node under sustained peak load.
- **Security:** mutual TLS required; client certificates issued by Kestrel with a maximum lifetime of 45 days. ==Plaintext HTTP on any port is a release blocker.==
- **Observability:** every rejected batch emits a structured log line with `envelope_id`, `stream_id`, and a stable `reject_code`.

---

## 5. Data Model

```json
{
  "envelope_id": "env_7Qm2xVdKcR3tLp",
  "device_id": "dev-88123-arb",
  "emitted_at": "2026-01-14T09:22:31.482Z",
  "batches": [
    {
      "stream_id": "strm_4kdW9zLmQrT2xNvB1c",
      "calibration_ref": "cal-2025-11-a3",
      "samples": [
        { "t": 1768382551482, "v": 21.4471, "q": "ok" },
        { "t": 1768382551982, "v": 21.4503, "q": "ok" },
        { "t": 1768382552482, "v": 99.9999, "q": "suspect" }
      ]
    }
  ],
  "compression": "zstd-3",
  "schema": 2
}
```

Notes on the model:

- `t` is milliseconds since epoch, transmitted as an integer. *Fractional milliseconds are truncated, not rounded.*
- `schema` MUST equal `2` for this release. Envelopes with `schema: 1` are accepted until 2026-06-30 and translated by the shim in `internal/legacy/shim_v1.go`.
- `compression` is advisory; the actual encoding is negotiated by the `Content-Encoding` header.

---

## 6. API Sketch

### 6.1 `POST /v2/ingest`

Submits one envelope.

**Headers**

- `Authorization: Bearer <tenant token>` — required
- `X-Sablefin-Envelope-Id` — required, mirrors body field
- `Content-Encoding: zstd | identity`

**Responses**

- `202 Accepted` — all batches published.
- `207 Multi-Status` — mixed outcomes; see body.
- `409 Conflict` — `envelope_id` reused with a *different* payload hash.
- `429 Too Many Requests` — backpressure or quota.
- `503 Service Unavailable` — bus unreachable; safe to retry.

**Example 207 body**

```http
HTTP/2 207
Content-Type: application/json

{
  "ack_token": "ak_9WcQ2rT7hJ4nZbMx0LpSdFg8YvKu3Ate",
  "accepted": 5,
  "rejected": 1,
  "results": [
    { "index": 0, "status": "accepted", "offset": 448193 },
    { "index": 3, "status": "rejected",
      "reject_code": "TS_NONMONOTONIC",
      "detail": "sample 17 precedes sample 16" }
  ]
}
```

### 6.2 `GET /v2/ack/{ack_token}`

Returns the recorded disposition of a previously accepted envelope. Available for the length of the dedup window; afterwards returns `410 Gone`.

### 6.3 `GET /v2/health`

Returns `{"state":"ready"|"draining"|"degraded"}`. Load balancers MUST remove nodes reporting `draining` within **2 seconds**.

### 6.4 Reject Codes

| Code | Retryable | Meaning |
| --- | --- | --- |
| `SCHEMA_UNKNOWN` | no | `schema` value not supported |
| `TS_NONMONOTONIC` | no | timestamps out of order |
| `TS_SKEW` | yes | `emitted_at` outside clock window |
| `CAL_UNRESOLVED` | yes | calibration reference not yet cached |
| `QUOTA_EXCEEDED` | yes | tenant sample budget exhausted |
| `STREAM_SUPPRESSED` | no | operator-initiated block |

---

## 7. Rollout Plan

1. Deploy to the `arbor-2` staging region with synthetic load at 12% of projected peak.
2. Shadow-mirror 5% of production traffic for **14 days**; compare frame counts against `hopper-ingest`.
3. Cut over region by region, beginning with the lowest-volume region.
4. Decommission `hopper-ingest` no earlier than 30 days after the final cutover.

---

## 8. Open Questions

- Should the dedup window be tenant-configurable, or is a fixed 10 minutes sufficient? **Blocking for GA.**
- Do we need a wire-level ack for `sablefin-wire`, or is a TCP-level ack acceptable given the retry window?
- *Proposal pending:* move calibration cache warming into a sidecar to reduce cold-start rejects below 0.1%.
