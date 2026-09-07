# Technical Specification: Kestrel Ledger Sync Service (KLS)

**Document ID:** KLS-SPEC-0042
**Revision:** 3.1
**Status:** *Draft for internal review*
**Owner:** Distributed Systems Group, Halyard Platform Engineering
**Last modified:** 2031-04-18

---

## 1. Purpose and Scope

The Kestrel Ledger Sync Service (KLS) provides eventually-consistent replication of append-only transaction ledgers between geographically distributed edge nodes and a regional aggregation tier. It is intended for deployments where network partitions are frequent, links are metered, and clients cannot tolerate a synchronous write path exceeding **40 ms** at the 95th percentile.

This document covers the wire protocol, conflict resolution semantics, storage contract, and the public HTTP API surface. It does **not** cover the operator console, the billing meter export pipeline, or the hardware attestation flow — those are described in KLS-SPEC-0043 and KLS-SPEC-0051 respectively.

*Out of scope:* multi-tenant key custody, on-disk encryption at rest (handled by the underlying Sablefish volume driver), and any form of cross-region strong consistency.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Ledger** | An ordered, append-only sequence of *entries* identified by a 128-bit `ledger_id`. |
| **Entry** | An immutable record containing a payload of up to 64 KiB, a monotonic `seq`, and an author signature. |
| **Segment** | A contiguous run of up to 4096 entries, the unit of replication and compaction. |
| **Anchor** | A signed digest of a segment boundary used for divergence detection. |
| **Peer** | Any node participating in gossip, either an edge node or an aggregator. |
| **Horizon** | The highest `seq` a peer has durably committed *and* acknowledged to at least one quorum member. |

---

## 3. Functional Requirements

1. **Append durability.** A successful append response MUST imply the entry is persisted to at least two independent storage devices on the accepting node, with `fsync` completed on both.
2. **Ordering.** Entries within a single ledger MUST be totally ordered by `seq`. Gaps in `seq` are prohibited; a peer that detects a gap MUST enter *repair mode* for that ledger.
3. **Idempotency.** Every append MUST carry a client-supplied `idem_key` of 16–64 bytes. Replays within the retention window (default **6 hours**) MUST return the original result without creating a duplicate entry.
4. **Convergence.** Given a quiescent network for `T_conv = 3 × gossip_interval + 500 ms`, all reachable peers holding a ledger MUST converge to identical segment anchors.
5. **Divergence detection.** Anchor mismatch MUST be reported within two gossip rounds and MUST NOT be silently repaired; the service raises a `LEDGER_FORKED` condition requiring operator acknowledgement.
6. **Backpressure.** When a peer's uncommitted write buffer exceeds 80% of `buffer_bytes`, it MUST advertise reduced credit in gossip headers and reject new appends with `503` plus a `Retry-After` hint.
7. **Metered transfer.** Replication traffic MUST be compressible and MUST support a per-link byte budget; when the budget is exhausted, only anchor gossip continues.
8. **Observability.** Every state transition of a ledger replica MUST emit a structured event on the local audit stream with a stable `transition_code`.

---

## 4. Non-Functional Requirements

- **Latency budget:** append p50 ≤ 9 ms, p95 ≤ 40 ms, p99.9 ≤ 220 ms, measured at the node's ingress socket.
- **Throughput floor:** a single edge node on reference hardware (8 vCPU, NVMe, 2 Gb/s uplink) sustains ==12,000 appends per second== at a mean payload of 1.2 KiB.
- **Recovery:** a node rejoining after a partition of up to 72 hours MUST resynchronize without a full ledger scan, using segment anchors to bound the transferred range.
- **Footprint:** resident memory MUST NOT exceed 1.5 GiB with 2000 open ledgers.
- **Availability target:** 99.95% monthly for the append path per region.

---

## 5. Replication Model

KLS uses *anchored segment gossip*. Each peer periodically (default `gossip_interval = 750 ms`, jittered ±20%) exchanges a compact digest vector with a randomly selected subset of `fanout = 4` peers. The digest vector lists, for each ledger the peer holds, the highest complete segment index and its anchor hash.

Reconciliation proceeds in three phases:

1. **Digest exchange** — peers compare vectors and identify ledgers where indices or anchors differ.
2. **Range negotiation** — the lagging peer requests a byte-bounded range; the leading peer responds with a delta bundle, never exceeding `max_bundle_bytes` (default 4 MiB).
3. **Apply and re-anchor** — the lagging peer verifies signatures, appends entries, and recomputes anchors. Any verification failure aborts the whole bundle atomically.

Conflict resolution is deliberately minimal: because ledgers are single-writer per `ledger_id` (enforced by a lease held from the aggregation tier), *concurrent divergent writes indicate a lease violation and are treated as a fault, not a merge case.* Leases are granted for `lease_ttl = 30 s` and renewed at one-third of the TTL.

### 5.1 Anchor Computation

```python
import hashlib
import struct

ANCHOR_DOMAIN = b"kls/anchor/v3"

def compute_anchor(segment_index: int,
                   prev_anchor: bytes,
                   entries: list[dict]) -> bytes:
    """Fold a segment's entries into a 32-byte anchor.

    entries must be ordered by seq with no gaps. prev_anchor is the
    anchor of segment_index - 1, or 32 zero bytes for the first segment.
    """
    if len(prev_anchor) != 32:
        raise ValueError("prev_anchor must be exactly 32 bytes")

    h = hashlib.blake2b(digest_size=32, person=ANCHOR_DOMAIN[:16])
    h.update(struct.pack(">Q", segment_index))
    h.update(prev_anchor)

    expected = None
    for e in entries:
        if expected is not None and e["seq"] != expected:
            raise ValueError(f"gap at seq {expected}")
        expected = e["seq"] + 1

        h.update(struct.pack(">Q", e["seq"]))
        h.update(struct.pack(">I", len(e["payload"])))
        h.update(e["payload"])
        h.update(e["author_sig"])       # 64 bytes, Ed25519

    h.update(struct.pack(">I", len(entries)))
    return h.digest()
```

Implementations in other languages MUST produce byte-identical output for the same inputs. A conformance vector set is published as `kls-anchor-vectors-v3.json` (487 cases).

---

## 6. Public API

All endpoints are rooted at `https://{node}/kls/v3`. Requests and responses use `application/json` unless otherwise noted. Authentication uses a bearer token issued by the Halyard identity broker; tokens carry a `ledger_scope` claim.

### 6.1 Append Entry

```
POST /ledgers/{ledger_id}/entries
```

**Headers**

| Header | Required | Notes |
|---|---|---|
| `X-KLS-Idem-Key` | yes | 16–64 bytes, base64url |
| `X-KLS-Lease` | yes | Opaque lease token |
| `X-KLS-Durability` | no | `quorum` (default) or `local` |

**Request body**

```json
{
  "payload_b64": "eyJvcmRlciI6ICJBLTk5MTQifQ==",
  "content_type": "application/vnd.halyard.order+json",
  "labels": { "region": "eu-west-3", "priority": "normal" }
}
```

**Responses**

- `201 Created` — body contains `seq`, `segment_index`, `commit_ts_us`, `anchor_preview`.
- `200 OK` — idempotent replay; identical body to the original `201`, plus `"replayed": true`.
- `409 Conflict` — lease invalid or superseded. Body includes `current_lease_holder`.
- `503 Service Unavailable` — backpressure; `Retry-After` in milliseconds.

### 6.2 Read Range

```
GET /ledgers/{ledger_id}/entries?from_seq=1024&limit=256&include_sigs=true
```

Returns entries in ascending `seq`. `limit` is clamped to **512**. The response carries `X-KLS-Horizon` so readers can distinguish *committed* from *provisional* tails.

### 6.3 Anchor Query

```
GET /ledgers/{ledger_id}/anchors?from_segment=0&to_segment=64
```

Returns an array of `{segment_index, anchor_hex, entry_count, sealed_at_us}`. Unsealed segments are omitted. This endpoint is the primary tool for external auditors and is rate-limited to ==60 requests per minute per token==.

### 6.4 Lease Management

```
POST   /ledgers/{ledger_id}/lease        # acquire or renew
DELETE /ledgers/{ledger_id}/lease        # voluntary release
```

Acquisition body: `{ "holder_id": "edge-tallin-07", "ttl_ms": 30000 }`.
A renewal that arrives after expiry MUST fail with `410 Gone` rather than silently re-acquiring.

### 6.5 Peer Gossip (internal)

```
POST /internal/gossip/digest
POST /internal/gossip/bundle
```

These are mTLS-only and never exposed beyond the replication VLAN. Bundles use a length-prefixed binary framing with Zstandard level 3; JSON is not permitted here for size reasons.

---

## 7. Error Model

All error bodies share the shape:

```json
{
  "code": "LEDGER_FORKED",
  "message": "anchor mismatch at segment 918",
  "retriable": false,
  "detail": { "local_anchor": "9f2c…", "peer_anchor": "41ab…", "peer": "agg-riga-02" },
  "trace_id": "01HZQ4T7K3M8"
}
```

Defined codes: `IDEM_KEY_INVALID`, `LEASE_EXPIRED`, `LEASE_CONFLICT`, `SEQ_GAP`, `LEDGER_FORKED`, `BUDGET_EXHAUSTED`, `PAYLOAD_TOO_LARGE`, `SCOPE_DENIED`, `BUFFER_FULL`.

Clients MUST treat unknown codes as non-retriable unless `retriable` is `true`.

---

## 8. Configuration Surface

| Key | Default | Range |
|---|---|---|
| `gossip_interval_ms` | 750 | 200–5000 |
| `fanout` | 4 | 2–12 |
| `max_bundle_bytes` | 4194304 | 262144–33554432 |
| `segment_entries` | 4096 | 512–16384 |
| `lease_ttl_ms` | 30000 | 5000–120000 |
| `idem_retention_s` | 21600
