# Technical Specification: Ravenloop Task Scheduler (RTS-7)

## 1. Overview

The **Ravenloop Task Scheduler** (internally codenamed *Thornfield*) is a lightweight distributed job orchestration engine designed to coordinate asynchronous workloads across heterogeneous compute nodes. This document specifies the architecture, API surface, and performance requirements for version 7.2 of the system.

The scheduler's primary goal is to minimize *tail latency* while maximizing throughput under bursty load conditions. Unlike prior iterations, RTS-7 introduces a ==priority-decay queueing model== that adjusts task weight dynamically based on wait time.

> [!note]
> This specification assumes familiarity with the Ravenloop cluster runtime (RCR) and its node-discovery protocol, described separately in document RVL-014.

## 2. Goals and Non-Goals

### 2.1 Goals

1. Provide a deterministic scheduling algorithm with bounded worst-case latency.
2. Support **at-least-once** delivery semantics for all queued tasks.
3. Allow pluggable backends for persistence (in-memory, disk-backed, or remote key-value store).
4. Expose a minimal, stable API surface for client libraries in at least three languages.
5. Guarantee graceful degradation when node count drops below a configured quorum threshold $q_{min}$.

### 2.2 Non-Goals

- RTS-7 does not attempt to provide strong consistency guarantees across geographically distributed regions.
- The scheduler does not manage container lifecycle; that responsibility belongs to the Orbital runtime layer.

## 3. Architecture

The system is composed of three logical tiers:

- **Dispatcher** — accepts incoming task submissions and performs initial validation.
- **Coordinator** — maintains the global queue state and assigns tasks to worker nodes.
- **Worker Pool** — executes tasks and reports completion or failure status back to the Coordinator.

Each Coordinator instance maintains a local priority heap keyed by an *effective priority score*. The score for a task $i$ at time $t$ is computed as:

$$
P_i(t) = P_i^{0} \cdot e^{-\lambda (t - t_i^{submit})} + \beta \cdot \frac{w_i}{\max(1, d_i)}
$$

where $P_i^{0}$ is the initial priority, $\lambda$ is the decay constant, $w_i$ is the accumulated wait time, and $d_i$ is the task's declared deadline offset.

For a quick sanity check, note that when $\lambda = 0$ and $\beta = 0$, the formula reduces to the static priority $P_i(t) = P_i^{0}$, which matches the behavior of RTS-6.

The relationship between decay constant $\lambda$ and average queue depth $\bar{Q}$ is approximated empirically as $\lambda \approx 0.003 \cdot \bar{Q}^{0.5}$, though this may be tuned per deployment.

## 4. Functional Requirements

1. The system **must** accept task submissions via both synchronous and asynchronous API calls.
2. Task payloads **must not** exceed 2 MiB in serialized form; larger payloads should be referenced via an external blob store.
3. The Coordinator **must** re-balance the worker assignment table whenever cluster membership changes by more than 15%.
4. All task state transitions **must** be logged to the durable event log with a monotonically increasing sequence number.
5. The API **should** support optional idempotency keys to prevent duplicate execution during retries.
6. Configuration values (e.g., $\lambda$, $\beta$, $q_{min}$) **must** be hot-reloadable without restarting the Coordinator process.

> [!warning]
> Setting $\lambda$ too high in combination with a small $q_{min}$ can cause *priority thrashing*, where low-priority tasks starve indefinitely because decay outweighs deadline pressure. Deployments should validate parameter combinations against the provided simulation harness before production rollout.

## 5. API Sketch

Below is a representative sketch of the core client-facing interface, written in a Go-like pseudocode for illustration purposes only.

```go
package thornfield

// Task represents a unit of schedulable work.
type Task struct {
    ID           string
    Payload      []byte
    Priority     float64
    DeadlineMs   int64
    IdempotentKey string
}

// SchedulerClient defines the primary interaction surface.
type SchedulerClient interface {
    // Submit enqueues a task and returns immediately with a receipt.
    Submit(ctx context.Context, t Task) (Receipt, error)

    // Await blocks until the task reaches a terminal state or timeout elapses.
    Await(ctx context.Context, id string, timeout time.Duration) (Result, error)

    // Cancel attempts to remove a task from the queue before execution.
    Cancel(ctx context.Context, id string) error

    // Status queries the current lifecycle state of a task.
    Status(ctx context.Context, id string) (TaskState, error)
}

type Receipt struct {
    TaskID     string
    AcceptedAt time.Time
    Node       string // assigned coordinator shard, if known
}

type TaskState int

const (
    StatePending TaskState = iota
    StateRunning
    StateCompleted
    StateFailed
    StateCancelled
)
```

Clients interact with the Coordinator over a lightweight RPC transport (Ravenloop calls this *Fenwire*), which serializes requests using a compact binary format rather than JSON, reducing overhead by roughly 40% in benchmark tests.

### 5.1 Error Semantics

All API methods return errors conforming to the `ThornfieldError` taxonomy, which includes at minimum the categories `Transient`, `Permanent`, and `QuotaExceeded`. Clients should treat `Transient` errors as retryable with exponential backoff, starting at 50ms and capping at 4 seconds.

## 6. Performance Requirements

- 99th-percentile submission latency must remain under **120 milliseconds** at a sustained load of 8,000 tasks/second per Coordinator shard.
- The system must tolerate the loss of any single Coordinator node without dropping in-flight tasks, provided replication factor $r \geq 2$.
- Recovery time objective (RTO) after a Coordinator failure must not exceed **6 seconds**.

## 7. Security Considerations

All inter-node communication must be encrypted using mutually authenticated TLS. Task payloads containing sensitive data should be encrypted client-side prior to submission; the Coordinator treats payloads as opaque bytes and performs no inspection.

## 8. Open Questions

- Should the decay constant $\lambda$ be per-tenant configurable, or globally fixed per cluster?
- What is the appropriate default for $\beta$ when deadlines are omitted entirely?

These questions are tracked in the Thornfield design backlog under ticket group RVL-THN-22 through RVL-THN-27, pending further benchmarking against synthetic workload traces generated by the *Hollowmere* load generator.
