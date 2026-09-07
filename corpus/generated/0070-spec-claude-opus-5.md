# Tidewell — Telemetry Ingestion & Rollup Service

**Document ID:** TDW-SPEC-0142
**Version:** 0.9 (draft for review)
**Status:** Proposed
**Owners:** Platform Hydrology Group
**Last revised:** 2031-04-18

---

## 1. Purpose and Scope

Tidewell is an internal service that accepts high-frequency measurement streams from moored and drifting marine sensor platforms, normalizes them against pinned schemas, and produces time-bucketed rollups that downstream analytics tools can query without touching raw storage.

This document specifies the externally visible behavior of Tidewell: its resource model, ingestion contract, query surface, error semantics, and the performance envelope it commits to. It does **not** specify the internal storage engine, the schema registry's replication topology, or the firmware running on the sensor platforms themselves. Those are covered by TDW-SPEC-0143 and FW-BUOY-0088 respectively.

In scope:

- Authenticated ingestion of numeric and categorical observations from registered platforms.
- Schema validation, unit coercion, and rejection of malformed records.
- Deterministic rollups at fixed bucket widths.
- A read API for both raw windows and rollups.
- Backfill of late-arriving data within a bounded lateness horizon.

Out of scope:

- Alerting, thresholding, or anomaly detection.
- Long-term archival beyond the 400-day hot retention window.
- Any form of cross-platform data fusion or interpolation.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Platform** | A physical or virtual device that emits observations. Identified by a `platform_id` of the form `pf_` + 12 lowercase base32 characters. |
| **Channel** | A named measurement series on a platform, e.g. `sea_surface_temp`. Scoped to a platform; not globally unique. |
| **Observation** | A single `(channel, timestamp, value)` triple plus optional quality flags. |
| **Envelope** | A batch of observations submitted in one request, sharing a platform and a schema pin. |
| **Bucket** | A fixed-width, left-closed, right-open time interval used for rollups. |
| **Lateness horizon** | The maximum age of an observation that Tidewell will accept for rollup recomputation. Fixed at 96 hours. |
| **Pin** | An immutable `(schema_name, revision)` pair asserted by the client at ingest time. |

---

## 3. Functional Requirements

**FR-1 — Envelope ingestion.** The service SHALL accept envelopes containing between 1 and 5,000 observations. Envelopes exceeding 5,000 observations SHALL be rejected with `envelope_too_large`.

**FR-2 — Schema pinning.** Every envelope SHALL declare a schema pin. If the pin does not resolve to a published revision, the envelope SHALL be rejected in whole. Partial acceptance on schema failure is prohibited.

**FR-3 — Per-observation validation.** After the pin resolves, each observation SHALL be validated independently. Valid observations SHALL be durably accepted even when sibling observations in the same envelope fail. The response SHALL enumerate every rejected index.

**FR-4 — Idempotency.** Clients MAY supply an `envelope_key` (max 64 characters). Tidewell SHALL treat two envelopes with the same `(platform_id, envelope_key)` submitted within 24 hours as a single logical submission and SHALL return the original result without reprocessing.

**FR-5 — Unit coercion.** Where the pinned schema declares a canonical unit, values submitted in a declared alternate unit SHALL be converted using the conversion table bound to that schema revision. Coercion failures are per-observation rejections, not envelope rejections.

**FR-6 — Rollup production.** For each `(platform_id, channel, bucket_width)` the service SHALL maintain rollups at bucket widths of 60 s, 900 s, 3600 s, and 86400 s. Each rollup SHALL expose: `count`, `min`, `max`, `mean`, `sum`, `p50`, `p95`, and `flagged_count`.

**FR-7 — Late data.** Observations with timestamps up to 96 hours older than ingest time SHALL trigger recomputation of every affected bucket at every width. Observations older than 96 hours SHALL be rejected with `beyond_lateness_horizon`.

**FR-8 — Future data.** Observations timestamped more than 300 seconds in the future relative to server clock SHALL be rejected with `timestamp_in_future`.

**FR-9 — Raw window reads.** Clients SHALL be able to retrieve raw observations for a single platform over a window not exceeding 6 hours, with cursor pagination.

**FR-10 — Rollup reads.** Clients SHALL be able to retrieve rollups for up to 24 channels on a single platform, over a window bounded by 4,000 buckets at the requested width.

**FR-11 — Platform registration.** A platform MUST be registered and in state `active` before ingestion succeeds. States are `provisioned`, `active`, `quarantined`, `retired`.

**FR-12 — Quarantine.** An operator SHALL be able to move a platform to `quarantined`, after which ingestion returns `platform_quarantined` and existing data remains readable.

**FR-13 — Deletion.** A `DELETE` on a platform SHALL transition it to `retired` and schedule raw-data purge after 30 days. Rollups persist for the full retention window.

---

## 4. Non-Functional Requirements

**NFR-1 — Ingest throughput.** Sustained 48,000 observations per second per region, with burst tolerance to 130,000 observations per second for 90 seconds.

**NFR-2 — Ingest latency.** p50 ≤ 22 ms, p99 ≤ 140 ms measured at the gateway edge for envelopes of ≤ 200 observations.

**NFR-3 — Rollup freshness.** For on-time data, the 60 s bucket SHALL reflect an accepted observation within 8 seconds at p99. Wider buckets SHALL converge within 45 seconds at p99.

**NFR-4 — Availability.** 99.94% monthly for the ingest path, 99.90% for the read path, measured on non-4xx responses.

**NFR-5 — Durability.** Once a 202 is returned, accepted observations SHALL survive the loss of any single availability zone. Target annual durability 99.999999%.

**NFR-6 — Retention.** Raw observations: 45 days. Rollups: 400 days. Both measured from observation timestamp, not ingest time.

**NFR-7 — Backpressure.** Under overload the service SHALL shed load with `429` and a `Retry-After` header rather than degrading latency beyond NFR-2.

> **Design note.** We deliberately chose per-observation rejection over strict all-or-nothing envelopes. Field experience with the previous collector showed that a single drifting clock on one channel could stall an entire platform's telemetry for days. The cost is a more verbose response body and a harder idempotency story — which is why `envelope_key` deduplication returns the *cached original result* rather than re-validating.

---

## 5. Data Model

```json
{
  "envelope_key": "buoy-4471-2031-04-18T09:15Z-a",
  "platform_id": "pf_k3m9qxr72dwv",
  "schema": { "name": "coastal_basic", "revision": 7 },
  "observations": [
    {
      "channel": "sea_surface_temp",
      "t": "2031-04-18T09:15:03.220Z",
      "value": 11.84,
      "unit": "degC",
      "flags": []
    },
    {
      "channel": "significant_wave_height",
      "t": "2031-04-18T09:15:03.220Z",
      "value": 2.31,
      "unit": "m",
      "flags": ["sensor_warmup"]
    },
    {
      "channel": "battery_bus",
      "t": "2031-04-18T09:15:03.220Z",
      "value": 13.44,
      "unit": "V",
      "flags": []
    }
  ]
}
```

Field notes:

- `t` MUST be RFC 3339 with an explicit offset. Millisecond precision is retained; sub-millisecond digits are truncated, not rounded.
- `value` is a JSON number for numeric channels and a string for categorical channels. Mixing types within a channel across the retention window is rejected with `channel_type_conflict`.
- `flags` are drawn from a closed vocabulary bound to the schema revision. Unknown flags cause per-observation rejection.
- `unit` is optional; when absent, the schema's canonical unit is assumed.

---

## 6. API Sketch

Base URL: `https://tidewell.internal.svc/v1`
All requests require `Authorization: Bearer <token>` and `X-Tidewell-Tenant: <tenant_id>`.

### 6.1 Ingest

```http
POST /v1/platforms/pf_k3m9qxr72dwv/envelopes HTTP/1.1
Content-Type: application/json
Idempotency-Scope: platform

{ "...envelope body as in section 5..." }
```

**202 Accepted**

```json
{
  "envelope_id": "env_8fb2c19d44a0",
