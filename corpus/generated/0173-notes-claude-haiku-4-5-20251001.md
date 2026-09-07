# Research Notes: Caching Strategies for Real-Time Data Processing

## Overview

This document compares three distinct approaches to managing cache coherency in distributed systems processing real-time telemetry data. Our team at DataFlow Systems has been investigating optimal solutions for our time-series analytics platform, which currently handles approximately 2.3 million data points per second across 47 regional clusters.

## Problem Statement

Our primary challenge involves maintaining data consistency while minimizing latency in a system where:

- Multiple microservices request identical datasets simultaneously
- Data freshness requirements vary by consumer (ranging from sub-100ms to 5-minute staleness tolerance)
- Network bandwidth constraints limit broadcast replication
- Computational costs increase with cache misses beyond threshold value $t > 0.15$

The mathematical relationship governing our system efficiency can be expressed as:

$$E = \frac{H \cdot w_h + (1-H) \cdot (-w_m)}{C_{network} + C_{compute}}$$

where $E$ represents efficiency, $H$ is cache hit ratio, $w_h$ and $w_m$ are weights for hits and misses respectively, and $C$ values represent associated costs.

## Approach 1: Write-Through Invalidation (WTI)

### Description

The Write-Through Invalidation strategy implements immediate cache invalidation upon any data modification. When a producer service updates a record, it simultaneously:

1. Persists data to primary storage
2. Broadcasts invalidation messages to all known cache nodes
3. Waits for acknowledgment before returning control to the caller

### Implementation Details

This approach uses a publish-subscribe model where invalidation messages are prioritized in the message queue. Our prototype implementation used the following core logic:

```python
class WriteThroughCache:
    def __init__(self, ttl_seconds=300):
        self.cache_store = {}
        self.ttl_seconds = ttl_seconds
        self.invalidation_channel = RedisChannel("cache.invalidate")
    
    def write_and_invalidate(self, key, value, affected_keys):
        try:
            self._persist_to_storage(key, value)
            invalidation_msg = {
                "timestamp": time.time(),
                "keys": affected_keys,
                "source": self.node_id
            }
            self.invalidation_channel.publish(invalidation_msg)
            self._wait_for_acks(affected_keys, timeout=5.0)
        except TimeoutError:
            self._log_partial_invalidation(key, affected_keys)
    
    def get(self, key):
        if key in self.cache_store:
            return self.cache_store[key]
        value = self._fetch_from_storage(key)
        self.cache_store[key] = value
        return value
```

### Advantages

- Guarantees strong consistency across all cache nodes
- Simpler debugging and reasoning about system state
- Eliminates stale data issues that plague distributed systems
- Well-understood operational characteristics

### Disadvantages

- Increased latency due to acknowledgment requirements
- Network overhead scales linearly with invalidation frequency
- Vulnerable to acknowledgment failures causing partial inconsistency
- Resource-intensive for high-frequency update workloads

## Approach 2: Time-Based Expiration with Lazy Updates (TBEU)

### Description

Rather than active invalidation, the TBEU strategy assigns time-to-live (TTL) values to cached entries. Each cache entry becomes automatically invalid after expiration, and clients refetch from source on subsequent access. This passive approach eliminates coordinated invalidation entirely.

### Key Features

The TBEU method incorporates several refinements:

- **Adaptive TTL Assignment**: TTL values adjust based on observed update frequency patterns
  - Base TTL: $TTL_{base} = 120$ seconds
  - Adjustment factor: $TTL_{adaptive} = TTL_{base} \cdot \left(1 + \frac{1}{update\_rate + 1}\right)$
  - Minimum TTL: 30 seconds, Maximum TTL: 600 seconds

- **Hierarchical expiration tracking**:
  1. Global TTL registry
     - Maintains cluster-wide expiration schedule
     - Processes expirations in batches every 10 seconds
     - Synchronizes with authoritative time source
  2. Node-local cache layers
     - Application-level cache with aggressive eviction
       - Implements LRU (Least Recently Used) replacement
       - Target utilization: 85% of available memory
       - Eviction triggers background garbage collection
     - System-level cache with permissive retention
  3. Distributed consistency checkpoints
     - Periodic verification against source of truth
     - Triggered when staleness threshold $s > 0.08$ is exceeded
     - Corrective refetches populate local cache

### Prototype Code

```javascript
class TimeBasedExpirationCache {
    constructor(baseGcInterval = 10000) {
        this.cache = new Map();
        this.expirationTimes = new Map();
        this.baseGcInterval = baseGcInterval;
        this.startGarbageCollection();
    }
    
    set(key, value, ttlSeconds) {
        const expirationTime = Date.now() + (ttlSeconds * 1000);
        this.cache.set(key, value);
        this.expirationTimes.set(key, expirationTime);
    }
    
    get(key) {
        if (!this.cache.has(key)) {
            return null;
        }
        
        const expirationTime = this.expirationTimes.get(key);
        if (Date.now() > expirationTime) {
            this.cache.delete(key);
            this.expirationTimes.delete(key);
            return null;
        }
        
        return this.cache.get(key);
    }
    
    startGarbageCollection() {
        setInterval(() => {
            const now = Date.now();
            for (const [key, expTime] of this.expirationTimes) {
                if (now > expTime) {
                    this.cache.delete(key);
                    this.expirationTimes.delete(key);
                }
            }
        }, this.baseGcInterval);
    }
}
```

### Advantages

- Minimal network overhead with no coordination messages
- Dramatically reduced write latency
- Elegant handling of node failures (no acknowledgment mechanism required)
- Scales well to hundreds of cache nodes

### Disadvantages

- Temporary data inconsistency is inevitable
- Difficult to control maximum staleness across all consumers
- Cold starts generate traffic spikes when cache entries expire simultaneously
- Requires careful TTL tuning; suboptimal values harm performance significantly

## Approach 3: Event-Driven Conditional Propagation (EDCP)

### Description

The EDCP strategy combines selective invalidation with time-based fallback mechanisms. Updates are propagated only when they exceed a significance threshold, and clients track which events they've already processed to avoid duplicate updates.

## Comparative Analysis

| Characteristic | WTI | TBEU | EDCP |
|---|---|---|---|
| **Consistency Guarantee** | Strong | Eventual | Strong with window |
| **Maximum Staleness (ms)** | <10 | 30,000–600,000 | <500 |
| **Write Latency (p99)** | 145 ms | 8 ms | 22 ms |
| **Network Bandwidth (MB/s)** | 340 | 12 | 78 |
| **Operational Complexity** | Medium | Low | High |
| **Failure Recovery Time** | 8–15 seconds | Automatic | 5–10 seconds |
| **Best Use Case** | Financial transactions | Sensor readings | User preferences |

## Experimental Results Summary

Our testing evaluated each approach under realistic production load using the DataFlow telemetry simulator. Key findings:

### Latency Performance

- **WTI**: 145ms average write latency; 95th percentile reaches 310ms during peak hours
- **TBEU**: 8ms average; 18ms at 95th percentile; no performance degradation observed
- **EDCP**: 22ms average; scales linearly with data change frequency; 64ms at 95th percentile

### Consistency Metrics

Under network partition simulation lasting 5 seconds:
- WTI: 100% consistency after recovery
- TBEU: Maximum 600-second stale reads; 87% of queries returned fresh data
- EDCP: Maximum 480-millisecond stale reads; 99.4% fresh query rate

### Resource Consumption

Testing on 16-node cluster with 500GB total cache:
- WTI consumed 24% additional bandwidth compared to baseline
- TBEU reduced bandwidth by 94% against invalidation approach
- EDCP balanced approach used 31% above baseline

## Recommendation

For DataFlow's telemetry platform, we recommend **hybrid deployment**:

1. **Primary tier**: TBEU for general-purpose sensor data (90% of traffic)
   - Tolerates higher staleness
   - Consumes minimal network resources
   - Operational simplicity reduces incident response time

2. **Secondary tier**: EDCP for user-facing dashboards (8% of traffic)
   - Balances consistency and performance
   - Event filtering reduces unnecessary propagation
   - Scales to accommodate dashboard interactions

3. **Tertiary tier**: WTI for restricted analytics (2% of traffic)
   - Financial calculations requiring strong consistency
   - Regulatory compliance requirements
   - Accept latency penalties for correctness guarantees

This strategy allocates resources efficiently while meeting distinct consistency requirements of different consumer classes. The approach anticipates future scaling to 150 million data points per second with projected 12% infrastructure cost reduction compared to pure WTI deployment.
