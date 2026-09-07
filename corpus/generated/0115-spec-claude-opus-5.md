# Corvid Ledger Service — Technical Specification

**Document ID:** NBK-SPEC-0417
**Version:** 0.4 (draft)
**Owner:** Ledger Platform Group, Ninebark Systems
**Status:** In review — targeted for freeze at the end of sprint 62
**Audience:** Backend engineers, SRE, partner integrators

---

## 1. Overview

Corvid is an append-only audit ledger service. It accepts structured *events* from internal services and partner systems, assigns each event a monotonic position within a *stream*, and links every entry into a tamper-evident hash chain. Consumers can read forward from any position, request an inclusion proof for a single entry, and verify that a range of entries has not been altered since it was written.

Corvid replaces the ad-hoc `audit_log` tables that currently live in seven separate service databases. Those tables are mutable, inconsistently indexed, and impossible to reconcile across services during an incident review. Corvid centralizes the write path and makes retroactive edits detectable rather than merely discouraged.

This document specifies the v1 wire contract, the durability and consistency guarantees, and the operational envelope. It does not specify the storage engine internals, which are covered in NBK-DESIGN-0388.

---

## 2. Goals and Non-Goals

- **Goals**
  - Provide a single write API for audit-grade events across all first-party services.
  - Make unauthorized mutation *detectable* by any reader holding a prior checkpoint.
  - Support high-cardinality stream partitioning without operator intervention.
    - Streams are created implicitly on first write.
    - Stream names are namespaced by tenant.
      - Namespace collisions across tenants are impossible by construction.
      - A tenant may hold at most 250,000 live streams before a soft quota alarm fires.
        - The alarm is advisory in v1; enforcement lands in v1.2.
  - Offer read latency low enough for interactive incident tooling (see §6).
- **Non-Goals**
  - Corvid is not a message bus. There is no fan-out, no consumer groups, and no at-least-once redelivery semantics.
  - Corvid does not interpret event payloads. Schema validation is the caller's responsibility.
  - Corvid does not provide deletion. Redaction is handled by the separate Tombstone Registry (NBK-SPEC-0402) and only ever masks payloads at read time; chain digests remain intact.
  - No SQL-style ad-hoc querying. Filtering is limited to the indexed fields listed in §5.

---

## 3. Definitions

| Term | Meaning |
| --- | --- |
| **Event** | An immutable record submitted by a client, consisting of metadata and an opaque payload. |
| **Stream** | An ordered sequence of events sharing a name and tenant. Ordering is total within a stream. |
| **Position** | A 64-bit unsigned integer, starting at 1, identifying an event's slot in its stream. |
| **Link digest** | SHA-256 over the canonical serialization of an entry, including the previous entry's link digest. |
| **Checkpoint** | A signed `(stream, position, link_digest)` triple published every 30 seconds. |
| **Sealed range** | A contiguous position range that has been written to two independent storage zones. |

---

## 4. Functional Requirements

1. **FR-1 — Append.** The service MUST accept single events and batches of up to 500 events in one request. A batch is atomic: either all events receive positions or none do.
2. **FR-2 — Idempotency.** Every append MUST carry a client-supplied `idem_key`. A repeated `idem_key` within a 26-hour window MUST return the originally assigned positions with HTTP `200` rather than appending duplicates.
3. **FR-3 — Ordering.** Within a stream, positions MUST be dense (no gaps) and strictly increasing. Across streams, no ordering is guaranteed.
4. **FR-4 — Chaining.** Each entry's `link_digest` MUST be computed over the canonical form defined in §7. The first entry in a stream uses a 32-byte zero value as its predecessor digest.
5. **FR-5 — Read forward.** Clients MUST be able to read from an arbitrary position, receiving up to 1,000 entries per page with an opaque continuation cursor.
6. **FR-6 — Inclusion proof.** For any sealed position, the service MUST return a proof path allowing verification against a published checkpoint without downloading intermediate entries.
7. **FR-7 — Checkpoint publication.** Checkpoints MUST be signed with the ledger's active Ed25519 key and served from a public, cacheable endpoint. The key rotation schedule is 90 days with a 14-day overlap.
8. **FR-8 — Backpressure.** When a stream exceeds its sustained write quota, the service MUST reject with `429` and a `Retry-After` header rather than silently degrading latency for other tenants.
9. **FR-9 — Payload limits.** A single payload MUST NOT exceed 64 KiB. A batch body MUST NOT exceed 4 MiB after compression.
10. **FR-10 — Attribution.** Every entry MUST record the authenticated principal, the source IP prefix (/24 for IPv4, /48 for IPv6), and the request's trace identifier.

---

## 5. Indexed Fields

Only the following fields are indexed and therefore filterable on read:

- `actor_id` — exact match only
- `event_type` — exact match or single trailing wildcard (`billing.invoice.*`)
- `occurred_at` — range queries at second granularity
- `subject_ref` — exact match; intended for the object the event acts upon

Any other filtering must be performed client-side after retrieval.

---

## 6. Non-Functional Requirements

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-1 | Append p50 latency | ≤ 18 ms |
| NFR-2 | Append p99 latency | ≤ 140 ms |
| NFR-3 | Read-forward p99 latency (1,000 entries) | ≤ 220 ms |
| NFR-4 | Durability after `202` response | 2 zones, fsync'd |
| NFR-5 | Availability (writes) | 99.95% monthly |
| NFR-6 | Availability (reads) | 99.98% monthly |
| NFR-7 | Seal lag (append → sealed) | ≤ 4 s at p99 |
| NFR-8 | Sustained throughput per tenant | 12,000 events/s |
| NFR-9 | Retention | 7 years, no early expiry |

> A `202 Accepted` from the append endpoint means the batch is durable in two zones and has been assigned final positions. It does *not* mean the batch is sealed. Callers that require an inclusion proof immediately after writing must poll the seal status endpoint; expect a wait of up to four seconds. Treating `202` as "sealed" is the single most common integration error we saw during the pilot with the Fernwood billing team.

---

## 7. Canonical Serialization

The `link_digest` is computed over a fixed-width binary encoding, not over JSON. Field order is normative and no optional fields are permitted.

```text
canonical_entry :=
    prev_link_digest    32 bytes
    tenant_id           16 bytes  (UUID, big-endian)
    stream_id           16 bytes  (UUID, big-endian)
    position             8 bytes  (uint64, big-endian)
    occurred_at_micros   8 bytes  (int64,  big-endian)
    event_type_len       2 bytes  (uint16, big-endian)
    event_type           N bytes  (UTF-8, NFC-normalized)
    payload_len          4 bytes  (uint32, big-endian)
    payload              M bytes  (raw, as received)

link_digest := SHA-256(canonical_entry)
```

Implementations MUST reject any `event_type` containing characters outside `[a-z0-9._-]` or exceeding 128 bytes. Payloads are stored byte-identical to what was received after transport decompression; Corvid never re-encodes them.

---

## 8. Authentication and Authorization

Clients present a bearer token issued by the internal Warden identity service. Tokens carry a `tenant` claim and a set of scopes:

- `ledger.append` — write to any stream in the tenant
- `ledger.append:<prefix>` — write only to streams whose name starts with `<prefix>`
- `ledger.read` — read any stream in the tenant
- `ledger.proof` — fetch inclusion proofs and checkpoints
- `ledger.admin` — manage quotas and stream metadata

Checkpoint retrieval is unauthenticated by design so that external auditors can verify chains without holding tenant credentials. Checkpoints expose only digests, positions, and timestamps — never event payloads or stream names (stream identity is carried as an opaque UUID).

---

## 9. API Sketch

Base URL: `https://ledger.nbk-internal.net/v1`
All request and response bodies are `application/json` unless noted. All timestamps are RFC 3339 with microsecond precision in UTC.

### 9.1 Append events

```http
POST /v1/streams/billing.invoices/events HTTP/1.1
Host: ledger.nbk-internal.net
Authorization: Bearer <token>
Content-Type: application/json
X-Corvid-Idem-Key: 4b1f9c22-7d3e-4a05-9f18-6c0a2e5b7d31

{
  "events": [
    {
      "event_type": "billing.invoice.issued",
      "occurred_at": "2031-03-14T09:22:41.115332Z",
      "actor_id": "svc
