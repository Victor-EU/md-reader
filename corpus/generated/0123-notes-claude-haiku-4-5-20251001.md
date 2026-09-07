# Research Notes: Database Query Optimization Approaches

## Executive Summary

This document compares three distinct approaches to optimizing database query performance in the VertexDB system, specifically addressing the issue of slow aggregation queries on large datasets. The problem manifests when processing analytical queries across tables with millions of records, resulting in response times exceeding 30 seconds. We evaluate traditional indexing strategies, columnar data restructuring, and query rewriting techniques.

---

## Problem Statement

The current VertexDB implementation experiences performance degradation when executing aggregation queries on historical data tables. Specifically, a query calculating monthly revenue summaries across our transaction database takes approximately $T = 42$ seconds to complete. This latency directly impacts reporting dashboards and real-time analytics features.

Our benchmarking shows that the query must scan approximately $N = 8.5 \times 10^6$ rows across four related tables. The primary bottleneck occurs during the JOIN operations between the `transactions` and `merchant_details` tables.

## Display Math Block

The query cost model can be represented as:

$$C = \alpha \cdot I + \beta \cdot J + \gamma \cdot A$$

where $C$ represents total query cost, $I$ represents index lookup operations, $J$ represents join operations, $A$ represents aggregation operations, and $\alpha$, $\beta$, $\gamma$ are empirically determined coefficients specific to our hardware configuration.

---

## Approach One: Traditional B-Tree Indexing Strategy

### Overview

The conventional approach involves creating composite B-tree indices on join columns and filtered attributes. This method has been the industry standard for decades and remains effective for many workloads.

### Implementation Details

```sql
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id, transaction_date);
CREATE INDEX idx_merchant_details_active ON merchant_details(merchant_id) WHERE status = 'active';
ALTER TABLE transactions ADD COLUMN year_month VARCHAR(7) GENERATED ALWAYS AS (DATE_FORMAT(transaction_date, '%Y-%m')) STORED;
CREATE INDEX idx_transactions_yearmonth ON transactions(year_month, amount);
```

### Advantages

- Minimal schema modifications required
- Immediate implementation with existing database engines
- Proven effectiveness across numerous production systems
- Simple maintenance and monitoring procedures
- Reversible changes with no data restructuring costs

### Limitations

| Aspect | Detail | Impact |
|--------|--------|--------|
| Memory Usage | B-tree indices consume significant RAM | 3-5 GB additional overhead |
| Maintenance Overhead | Index updates on every INSERT/UPDATE | 12-15% write performance penalty |
| Selectivity Issues | Ineffective when filtering returns >15% of rows | Degrades for broad date ranges |
| Join Complexity | Limited optimization for multi-table joins | Still requires sequential access for large result sets |
| Storage Cost | Index duplication of key columns | Increased disk I/O and backup time |

### Estimated Performance Gain

With proper index design, this approach typically reduces query execution time by 35-45%. In our case, we project improvement from 42 seconds to approximately 23-27 seconds.

---

## Approach Two: Columnar Data Restructuring

### Overview

This approach migrates relevant data into a columnar storage format, which provides superior compression and vectorized query processing. The idea involves maintaining a separate columnar representation optimized for analytical queries.

### Implementation Details

```python
class ColumnarAggregationEngine:
    def __init__(self, database_connection):
        self.db = database_connection
        self.column_cache = {}
        
    def build_columnar_store(self, table_name, columns):
        """Convert row-oriented data to columnar format"""
        result_columns = {}
        for col in columns:
            query = f"SELECT {col} FROM {table_name} ORDER BY transaction_id"
            result_columns[col] = self.db.execute(query).fetchall()
        return result_columns
    
    def aggregate_columnar(self, metric, groupby_col):
        """Execute aggregation directly on columnar data"""
        if metric == 'sum':
            return sum(self.column_cache.get('amount', []))
        elif metric == 'avg':
            values = self.column_cache.get('amount', [])
            return sum(values) / len(values) if values else 0
```

### Advantages

- Dramatically improved compression ratios (typically 8:1 to 12:1)
- Vectorized processing utilizes modern CPU capabilities efficiently
- Exceptional performance for aggregate queries with selective columns
- Reduced I/O requirements due to column-level compression
- Natural alignment with SIMD instruction sets

### Limitations

- Significant engineering effort for implementation and maintenance
- Complex synchronization between row-oriented and columnar representations
- Update operations require re-processing of entire columns
- Introduces operational complexity with dual data representations
- Requires substantial development resources and testing

### Estimated Performance Gain

Columnar approaches typically achieve 60-75% improvement in aggregation query performance. We project reducing execution time to 10-17 seconds, assuming successful implementation without synchronization issues.

---

## Approach Three: Query Rewriting and Materialized Views

### Overview

> Rather than optimizing storage structures, this approach focuses on intelligent query restructuring and pre-computation. By analyzing query patterns and materializing common aggregations, we can serve results from pre-calculated data without executing expensive computations.

This strategy recognizes that many analytical queries follow predictable patterns and calculates results opportunistically during off-peak hours.

### Implementation Details

The implementation creates materialized views that aggregate data at multiple granularity levels:

```sql
CREATE MATERIALIZED VIEW mv_monthly_revenue AS
SELECT 
    DATE_FORMAT(t.transaction_date, '%Y-%m') AS month,
    m.merchant_category,
    m.region,
    COUNT(*) AS transaction_count,
    SUM(t.amount) AS total_amount,
    AVG(t.amount) AS average_amount,
    MIN(t.amount) AS min_amount,
    MAX(t.amount) AS max_amount
FROM transactions t
INNER JOIN merchant_details m ON t.merchant_id = m.merchant_id
WHERE t.transaction_date >= DATE_SUB(NOW(), INTERVAL 24 MONTH)
GROUP BY DATE_FORMAT(t.transaction_date, '%Y-%m'), m.merchant_category, m.region;

CREATE INDEX idx_mv_revenue_month ON mv_monthly_revenue(month);
CREATE INDEX idx_mv_revenue_category ON mv_monthly_revenue(merchant_category);
```

### Advantages

- Query results served from pre-computed aggregates (near-instantaneous)
- Minimal impact on production system resources during query time
- Straightforward implementation using standard SQL features
- Highly predictable performance characteristics
- Transparent to application layer with view abstraction

### Limitations

- Requires careful identification of query patterns and aggregation dimensions
- Materialized view refresh introduces staleness in data (typically 1-24 hours)
- Storage requirements grow with number of materialized views created
- Diminishing returns when query patterns are highly diverse
- Maintenance complexity increases with more materialized views

### Estimated Performance Gain

Materialized view queries execute in 0.2-0.8 seconds for cached aggregates. However, this applies only to queries matching pre-materialized dimensions. Non-matching queries still require full execution, potentially at original performance levels.

---

## Comparative Analysis

### Performance Summary

| Metric | B-Tree Indexing | Columnar Storage | Materialized Views |
|--------|-----------------|------------------|-------------------|
| Execution Time | 23-27 sec | 10-17 sec | 0.2-0.8 sec (cached) |
| Implementation Time | 1-2 weeks | 4-6 weeks | 2-3 weeks |
| Maintenance Burden | Low | High | Medium |
| Storage Overhead | 3-5 GB | +40% (compressed) | +20-30% (aggregates) |
| Data Freshness | Real-time | Real-time | 1-24 hours delay |
| Flexibility | High | High | Limited to pre-defined dimensions |

---

## Recommendation

A hybrid approach combining Approaches One and Three offers optimal balance. Implementing selective B-tree indices (2 weeks) alongside materialized views for the top 10 query patterns (3 weeks) provides:

1. Immediate 35-45% improvement from indexing
2. Near-instantaneous results for 70% of analytical queries via materialization
3. Fallback performance improvements for ad-hoc queries
4. Lower total implementation cost than columnar restructuring
5. Manageable operational complexity

This recommendation assumes query pattern analysis identifies clear opportunities for materialization. If query patterns prove too diverse, indexing alone becomes the pragmatic choice.

---

## Next Steps

1. Conduct detailed query pattern analysis across all reporting systems
2. Calculate exact storage and refresh costs for proposed materialized views
3. Prototype B-tree index configuration on staging environment
4. Establish performance baselines with current implementation
5. Implement hybrid solution in phased approach beginning with indices
6. Monitor and iterate based on production performance metrics
