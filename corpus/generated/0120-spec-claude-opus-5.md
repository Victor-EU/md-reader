# Nimbus Quota Broker — Technical Specification v0.4

**Status:** Draft · **Owner:** Platform Reliability Guild · **Target release:** Sprint 118

## 1. Purpose

The Nimbus Quota Broker (NQB) issues short-lived spend tokens that let downstream workers consume metered resources — GPU seconds, egress bytes, and outbound mail — without each worker maintaining its own counter. NQB is authoritative for allocation, not for billing; the billing pipeline consumes NQB's audit stream asynchronously.

## 2. Functional Requirements

- **FR-1** — The broker MUST grant or deny a lease within 40 ms at p99 under a sustained load of 6,000 requests per second per region.
- **FR-2** — Leases MUST expire automatically. Default time-to-live is 90 seconds; callers MAY request 5–600 seconds.
- **FR-3** — Unused portions of an expired lease MUST return to the parent bucket within one reconciliation tick (2 seconds).
- **FR-4** — Buckets MUST support hierarchical nesting:
  - Tenant bucket (`t:`)
    - Project bucket (`p:`)
      - Workload bucket (`w:`)
        - Ephemeral job bucket (`j:`), created on first grant and reaped after 24 h of inactivity
  - A child MUST NOT exceed its parent's remaining balance, even if the child's own ceiling is higher.
- **FR-5** — Every grant, denial, and reclaim MUST emit an audit record to the `nqb.ledger.v1` topic with a monotonic sequence number per shard.

## 3. Non-Functional Requirements

1. Availability target of 99.95% measured monthly per region, excluding scheduled maintenance windows announced 72 hours in advance.
2. Durable state replicated across three availability zones using quorum writes (2 of 3).
3. Cold start of a broker replica MUST complete bucket hydration in under 12 seconds for 250,000 buckets.
4. All inter-service traffic uses mutual TLS with certificates rotated every 30 days.
5. Clock skew between replicas MUST NOT exceed 250 ms; replicas exceeding this threshold MUST self-quarantine.

---

## 4. API Sketch

Base path: `https://nqb.internal/v1`. All requests carry `X-Nimbus-Actor` and an idempotency key.

```http
POST /v1/leases HTTP/1.1
Content-Type: application/json
Idempotency-Key: 4c1f-ae90-77b3

{
  "bucket": "t:brightwater/p:atlas/w:render-farm",
  "units": 2400,
  "resource": "gpu_seconds",
  "ttl_seconds": 120,
  "on_shortfall": "partial"
}
```

Successful response (`201 Created`):

```json
{
  "lease_id": "lse_8Qn2VdRk",
  "granted_units": 2400,
  "expires_at": "2031-03-14T09:42:11Z",
  "parent_remaining": 118400,
  "sequence": 90427715
}
```

### 4.1 Endpoint Summary

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/leases` | Request a new lease |
| `POST` | `/leases/{id}/extend` | Extend TTL, max two extensions |
| `DELETE` | `/leases/{id}` | Release unused units early |
| `GET` | `/buckets/{path}` | Read balance and ceiling |
| `PATCH` | `/buckets/{path}` | Adjust ceiling (admin scope) |

### 4.2 Error Semantics

- `409 quota_exhausted` — parent or child balance insufficient; response includes `retry_after_ms`.
- `422 bucket_depth_exceeded` — path deeper than four levels.
- `429 broker_saturated` — shard admission control engaged; clients MUST back off with full jitter.
- `503 hydrating` — replica is still loading state; clients SHOULD retry another replica.

## 5. Open Questions

- Should `on_shortfall: "queue"` be supported, or does queuing belong in the caller's scheduler?
- Whether ephemeral job buckets need per-region isolation or may float globally.
- Retention window for the audit topic: 30 days is proposed; finance has requested 400.
