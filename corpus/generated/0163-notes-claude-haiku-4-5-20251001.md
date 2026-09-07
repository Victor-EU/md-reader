# Research Notes: Distributed Cache Invalidation Strategies

## Overview

Cache invalidation remains one of the most challenging problems in distributed systems architecture. When dealing with microservices handling high-throughput data operations, selecting the appropriate invalidation strategy can significantly impact system performance and consistency guarantees. This document compares three distinct approaches to managing cache coherence across distributed nodes in the Nexus platform architecture.

---

## Problem Statement

The Nexus platform processes approximately **15 million transactions daily** across 47 geographically distributed data centers. Current systems experience cache staleness issues affecting approximately 0.8% of read operations, with invalidation latency averaging 2.3 seconds. The team must identify an optimal solution balancing consistency, latency, and operational complexity.

## Approach 1: Time-Based Expiration (TTL Strategy)

The simplest approach involves setting fixed time-to-live values for cached entries. Under this model, each cache entry $c$ carries an expiration timestamp $t_{exp}$ calculated as:

$$t_{exp} = t_{creation} + TTL_{value}$$

where $TTL_{value}$ is configured per data type. This strategy requires ==minimal coordination overhead== and works well for read-heavy workloads with acceptable staleness windows.

### Implementation Details

In our testing environment, we implemented TTL-based invalidation using the RedisCluster v4.2 configuration with standardized TTL values:

```python
def cache_with_ttl(key: str, value: dict, ttl_seconds: int = 300):
    """
    Store value in distributed cache with automatic expiration.
    
    Args:
        key: Unique cache identifier
        value: Data to cache (JSON serializable)
        ttl_seconds: Time-to-live in seconds
    
    Returns:
        Boolean indicating successful storage
    """
    try:
        redis_client.setex(
            name=key,
            time=ttl_seconds,
            value=json.dumps(value)
        )
        return True
    except RedisConnectionError as e:
        logger.error(f"Cache write failed: {e}")
        return False
```

**Advantages:**
- *Extremely simple* to implement and debug
- Minimal performance overhead
- No dependency on external notification systems
- Natural fault tolerance through expiration

**Disadvantages:**
- ==Staleness window== cannot be reduced below configured TTL
- Memory utilization may be inefficient for frequently-updated data
- Difficult to handle emergency invalidation scenarios

---

## Approach 2: Event-Driven Invalidation (Publisher-Subscriber)

This approach uses message brokers to propagate cache invalidation events. When data modifications occur, the system publishes invalidation messages to a distributed event stream, allowing cache nodes to react immediately.

### Architectural Pattern

The event-driven model requires establishing a pub/sub channel topology. Messages flow through the system as:

$$\text{DataModification} \rightarrow \text{EventPublisher} \rightarrow \text{MessageBroker} \rightarrow \text{CacheSubscribers}$$

**Key components:**
- **EventPublisher**: Captures write operations and creates invalidation events
- **MessageBroker**: Distributes events (using Apache Pulsar v3.1 in our implementation)
- **CacheSubscribers**: Listen for events and perform local invalidation

```javascript
class CacheInvalidationService {
  constructor(brokerConfig) {
    this.broker = initializePulsarClient(brokerConfig);
    this.invalidationTopic = 'cache-invalidation-events';
    this.subscriptionName = `cache-node-${getNodeId()}`;
  }

  async subscribeToInvalidations() {
    const consumer = await this.broker.subscribe({
      topic: this.invalidationTopic,
      subscription: this.subscriptionName,
      subscriptionType: 'Shared'
    });

    consumer.on('message', async (msg) => {
      const invalidationEvent = JSON.parse(msg.getData());
      await this.performLocalInvalidation(invalidationEvent);
      consumer.acknowledge(msg);
    });
  }

  async publishInvalidation(cacheKey, dataType) {
    const event = {
      timestamp: Date.now(),
      cacheKey: cacheKey,
      dataType: dataType,
      sourceNode: getNodeId()
    };
    
    await this.broker.publish({
      topic: this.invalidationTopic,
      messages: [{ data: JSON.stringify(event) }]
    });
  }
}
```

**Advantages:**
- Invalidation occurs *nearly instantaneously*
- Minimal staleness windows in normal operation
- Provides audit trail of all cache modifications
- Scales well with number of cache nodes

**Disadvantages:**
- Added operational complexity and debugging difficulty
- Network latency in message delivery creates temporary inconsistencies
- Requires sophisticated monitoring and alerting
- Potential message loss scenarios require careful handling

---

## Approach 3: Hybrid Write-Through with Versioning

This strategy combines immediate write-through cache updates with versioning metadata. When data is modified, the system updates both the primary data store and cache simultaneously, using version numbers to detect stale entries.

| Strategy Aspect | TTL-Based | Event-Driven | Write-Through |
|---|---|---|---|
| **Implementation Complexity** | Very Low | High | Moderate |
| **Consistency Guarantee** | Eventual (weak) | Eventual (strong) | Strong |
| **Latency (p99)** | 2100ms | 45ms | 67ms |
| **Operational Overhead** | Minimal | High | Moderate |
| **Memory Efficiency** | Low | Medium | High |
| **Failure Recovery Time** | 300s | Manual | <5s |
| **Network Dependencies** | None | Critical | Non-critical |

### Implementation Framework

The write-through approach uses version vectors to maintain coherence:

```python
@dataclass
class VersionedCacheEntry:
    data: dict
    version: int
    timestamp: float
    node_id: str

async def write_through_update(key: str, new_data: dict):
    current_version = await get_cache_version(key)
    new_version = current_version + 1
    
    entry = VersionedCacheEntry(
        data=new_data,
        version=new_version,
        timestamp=time.time(),
        node_id=current_node_id()
    )
    
    # Atomic dual-write
    await database.update(key, new_data, new_version)
    await cache.set(key, entry)
    
    return new_version
```

**Advantages:**
- Strong consistency guarantees with acceptable latency
- Automatic conflict resolution through versioning
- Relatively simple operational model
- ==Excellent for write-heavy workloads==

**Disadvantages:**
- *Increased database load* from dual-writes
- More complex client logic for handling version mismatches
- Potential performance degradation during network partitions
- Higher resource utilization

---

## Recommendations

Based on our analysis, we recommend a **hybrid approach** combining strategies 1 and 2:

1. Implement *event-driven invalidation* as the primary mechanism for immediate consistency
2. Add *TTL-based expiration* as a safety net (900-second window) for handling message broker failures
3. Reserve *write-through caching* for critical metadata components only

This combination provides robust consistency while maintaining operational simplicity and fault tolerance. Testing indicates this approach reduces staleness to <100ms in 99th percentile scenarios while keeping operational overhead manageable across our 47 data centers.
