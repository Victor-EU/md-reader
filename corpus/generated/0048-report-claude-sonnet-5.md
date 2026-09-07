# Project Status Report: **Aurora Data Pipeline Optimization**

**Report Date:** March 14, 2025
**Project Lead:** Priya Natarajan
**Sprint:** 14 of 20
**Status:** 🟡 On Track with Minor Risks

---

## Executive Summary

The Aurora Data Pipeline Optimization project has completed its fourth month of development, focusing on reducing end-to-end latency for our real-time analytics ingestion system. This quarter, the team successfully migrated the core transformation layer from a batch-oriented architecture to a *streaming-first* model built on Apache Flink. Overall throughput has improved by **42%**, though we've identified some memory pressure issues under peak load that require attention before the Q2 rollout.

> [!note]
> This report covers work completed between February 1 and March 14, 2025. All metrics are derived from our staging environment unless otherwise noted.

---

## Key Metrics

The following table summarizes our primary performance indicators compared to the previous reporting period:

| Metric | Previous (Feb 1) | Current (Mar 14) | Change |
|---|---|---|---|
| Avg. ingestion latency (ms) | 340 | 197 | -42.1% |
| P99 latency (ms) | 890 | 512 | -42.5% |
| Throughput (events/sec) | 12,400 | 21,300 | +71.8% |
| Memory utilization (peak, GB) | 18.2 | 26.7 | +46.7% |
| Error rate (%) | 0.083 | 0.041 | -50.6% |
| Test coverage (%) | 71 | 84 | +13 pts |

The throughput gains are especially encouraging, but the **memory utilization increase** is a flag we're actively investigating. Our working theory is that the new windowing strategy retains state longer than necessary during backpressure events.

### Latency Distribution Analysis

We modeled the latency distribution using a log-normal approximation. If $L$ represents the latency of a single event traversing the pipeline, we assume:

$$
f(L; \mu, \sigma) = \frac{1}{L \sigma \sqrt{2\pi}} \exp\left(-\frac{(\ln L - \mu)^2}{2\sigma^2}\right)
$$

Fitting this model to our observed data yields $\mu \approx 5.12$ and $\sigma \approx 0.38$, which aligns closely with empirical percentile measurements. This gives us a reasonably reliable way to forecast tail latency as load scales, since the median latency $e^{\mu}$ and the spread of the distribution are now well-characterized parameters we can track sprint over sprint.

---

## Architecture Changes

The most significant engineering effort this cycle was the redesign of the ingestion layer. Previously, our system relied on a polling-based consumer pattern against Kafka topics; we've since transitioned to a fully event-driven model using Flink's `KeyedProcessFunction` API.

Below is a simplified representation of the new stateful processing logic:

```java
public class SessionAggregator extends KeyedProcessFunction<String, Event, SessionResult> {

    private ValueState<SessionAccumulator> sessionState;

    @Override
    public void open(Configuration parameters) {
        ValueStateDescriptor<SessionAccumulator> descriptor =
            new ValueStateDescriptor<>("session-state", SessionAccumulator.class);
        sessionState = getRuntimeContext().getState(descriptor);
    }

    @Override
    public void processElement(Event event, Context ctx, Collector<SessionResult> out) throws Exception {
        SessionAccumulator acc = sessionState.value();
        if (acc == null) {
            acc = new SessionAccumulator();
        }
        acc.addEvent(event);
        sessionState.update(acc);

        long timeoutTimestamp = ctx.timestamp() + 30_000L; // 30s inactivity window
        ctx.timerService().registerEventTimeTimer(timeoutTimestamp);
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<SessionResult> out) throws Exception {
        SessionAccumulator acc = sessionState.value();
        if (acc != null) {
            out.collect(acc.finalize());
            sessionState.clear();
        }
    }
}
```

This approach eliminates the need for our previous cron-triggered aggregation jobs entirely, which were a persistent source of ==data staleness complaints== from the downstream reporting team. The trade-off, as noted above, is increased state retention overhead — something we're addressing in the next sprint.

> [!warning]
> Under sustained load exceeding 25,000 events/sec, we've observed occasional `TaskManager` OOM kills in staging. This has **not** yet occurred in production, but the risk is nontrivial and is being tracked as issue AURORA-ailed-441.

---

## Cost Analysis

Infrastructure spend has shifted meaningfully as a result of the architecture change. Our compute costs increased modestly due to the always-on nature of streaming task managers, but we've seen substantial savings in storage costs from reduced intermediate data staging.

Estimated monthly cost, where $C_{compute}$ and $C_{storage}$ represent compute and storage respectively:

- Previous total: $C_{compute} = \$4{,}200$, $C_{storage} = \$3{,}100$ → **$7,300/month**
- Current total: $C_{compute} = \$5{,}050$, $C_{storage} = \$1{,}400$ → **$6,450/month**

That's a net savings of approximately **11.6%**, which partially offsets the engineering investment required for the migration. We anticipate this margin will improve further once the memory optimization work lands, since we'll be able to right-size our task manager instances downward.

---

## Team Updates

The team composition shifted slightly this quarter. We onboarded one new engineer, *Tomás Rivera*, who joined specifically to support the observability tooling workstream. His initial focus has been instrumenting our Flink jobs with more granular custom metrics via the Micrometer integration.

Notable contributions this cycle:

1. **Priya Natarajan** — Led the core migration effort, wrote the majority of the `KeyedProcessFunction` implementations, and coordinated the staging rollout.
2. **Devon Achebe** — Built the new alerting rules in our monitoring stack (Grafana + Prometheus), reducing mean-time-to-detection for pipeline stalls from 14 minutes to under 3 minutes.
3. **Tomás Rivera** — Instrumented custom Micrometer metrics across four critical pipeline stages; still finalizing dashboards.
4. **Wren Kowalski** — Conducted the load testing that surfaced the memory pressure issue; authored the corresponding root-cause investigation doc.
5. **Sana Al-Farsi** — Reworked the schema registry integration to support backward-compatible Avro evolution, unblocking three downstream consumer teams.

The team's velocity has been *consistently strong*, averaging 38 story points per sprint over the last three sprints, up from a trailing average of 31.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Memory exhaustion under peak load | Medium | High | Investigating state TTL tuning; see task list below |
| Schema drift from upstream producers | Low | Medium | Schema registry validation gate added in CI |
| On-call fatigue from alert noise | Medium | Medium | Alert threshold tuning scheduled for next sprint |
| Vendor rate limiting on Kafka Connect | Low | Low | Monitoring usage against contract limits monthly |

The memory exhaustion risk remains our top concern heading into the next sprint. We believe the root cause is tied to unbounded state growth in sessions that never receive a closing event — essentially "zombie" sessions that linger indefinitely without ever hitting the 30-second inactivity timer cleanly, particularly when clock skew is introduced by late-arriving events.

---

## Task List — Sprint 15 Priorities

- [x] Complete migration of ingestion layer to Flink `KeyedProcessFunction`
- [x] Deploy updated schema registry validation to CI pipeline
- [x] Reduce alert mean-time-to-detection below 5 minutes
- [x] Finalize cost comparison analysis between old and new architecture
- [ ] Implement state TTL policy to cap session accumulator lifetime
- [ ] Load test with simulated 30,000 events/sec sustained traffic
- [ ] Finalize Micrometer dashboards for all four pipeline stages
- [ ] Conduct security review of new Kafka ACL configuration
- [ ] Draft rollback plan for production cutover
- [ ] Present findings to platform architecture review board

---

## Next Steps

Looking ahead to the next reporting period, our primary objective is resolving the memory pressure issue before we can responsibly greenlight a production rollout. The plan is as follows:

1. **Implement bounded state TTL** — We'll configure Flink's state backend to automatically expire session accumulators after 90 seconds of inactivity, regardless of whether the timer fires cleanly. This should cap worst-case memory growth even under adversarial event timing.
2. **Re-run load tests at higher sustained throughput** — Wren will lead a follow-up test targeting 30,000 events/sec, well above our current production ceiling, to validate the fix under realistic stress conditions.
3. **Right-size infrastructure** — Once memory behavior is stable, Devon will revisit our task manager instance sizing to see if we can claw back some of the compute cost increase mentioned earlier.
4. **Finalize observability tooling** — Tomás will complete the remaining dashboards so that on-call engineers have full visibility into state size, backpressure, and checkpoint duration across all pipeline stages.
5. **Schedule the architecture review** — We'll present the full migration story, including the cost and latency improvements, to the platform review board in early April, with a target production cutover date of April 21.

Overall, the project remains in good health. The architectural bet on a streaming-first design is paying off in the metrics that matter most to our stakeholders — latency and throughput — and the remaining memory concerns, while real, appear tractable with the mitigation plan outlined above. We'll provide an updated report following the completion of Sprint 15.

---

*Questions or feedback on this report can be directed to Priya Natarajan or raised in the #aurora-pipeline Slack channel.*
