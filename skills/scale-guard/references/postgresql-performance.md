# PostgreSQL Performance Diagnostic Guide

## First principle: interpret the plan, not the node label

A `Seq Scan` can be the correct plan. Judge total cost and measured execution against table size, rows returned, selectivity, cache state, and workload. A plan node name alone is not a diagnosis.

## Evidence to collect

Prefer read-only metadata and anonymised plan output:
- PostgreSQL version and relevant settings;
- query text with literals redacted or parameterised;
- `EXPLAIN (FORMAT JSON)` or `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS)` from a safe environment;
- table row estimates and approximate relation size;
- indexes and constraints;
- `pg_stat_statements` aggregates where installed;
- workload concurrency and frequency.

`EXPLAIN ANALYZE` executes the statement. It adds instrumentation overhead and may be unsafe for writes or expensive queries. Get explicit approval before running it against production.

## Reading common plan signals

- **Seq Scan:** determine relation size, actual rows, rows removed by filter, buffers read/hit, and fraction of table returned.
- **Index Scan:** inspect heap fetches, random I/O, selectivity, and whether many heap pages are visited.
- **Bitmap Heap Scan:** can be effective for moderate selectivity; inspect lossy pages and rechecks.
- **Nested Loop:** often fine for small outer input and indexed inner lookup; suspicious when outer rows/loops are unexpectedly large.
- **Hash Join:** inspect hash batches, memory, and temp I/O; batching may indicate memory pressure.
- **Sort:** inspect sort method, memory, disk spill, and whether a suitable index can satisfy ordering.
- **Aggregate:** inspect input cardinality and whether aggregation happens after avoidable row expansion.
- **Parallel plan:** check workers planned/launched and overhead; parallelism is not automatically faster.

## Estimated vs actual rows

Large estimation errors can lead to poor join order and access path. Investigate:
- stale statistics (`ANALYZE` timing and autovacuum health);
- data skew and correlated predicates;
- extended statistics for correlated columns when justified;
- parameter-sensitive workloads and generic/custom plans;
- expressions/casts that prevent expected index use.

Do not recommend `ANALYZE` or changing planner settings blindly; consider operational impact and verify.

## Index design checklist

Before suggesting an index:
1. Identify the exact predicate, join, and ordering expressions.
2. Check existing indexes, constraints, and overlapping indexes.
3. Evaluate selectivity and frequency of the query.
4. Consider a composite index whose leading columns match common equality predicates, followed by range/order columns where appropriate.
5. Consider a partial index only when its predicate matches a stable, common subset and the query predicate implies it.
6. Consider expression indexes only when the query expression matches.
7. Account for write amplification, storage, cache footprint, vacuum/maintenance, and deployment locking.
8. Validate with representative plans and workload tests.

Column order is workload-dependent; do not apply a universal "most selective first" rule. Equality/range/order combinations, other query shapes, and PostgreSQL planner behaviour matter.

## Sequential scan investigation checklist

Ask:
- Is the table small?
- Does the query return a large fraction of rows?
- Are many rows removed by filter?
- Are buffers mostly hits or physical reads?
- Is the scan repeated many times per API request?
- Are table statistics accurate?
- Does the predicate match the index definition and operator class?
- Is a cast, function, collation, or type mismatch affecting indexability?
- Is the query selecting too many columns?
- Is the real bottleneck elsewhere (pool wait, lock wait, network, app processing)?

## Other common bottlenecks

- N+1 queries and repeated point lookups;
- large sorts and hash spills;
- lock contention and long transactions;
- poor pagination (large OFFSET);
- unbounded result sets;
- JSON aggregation or PostGIS spatial predicates without suitable indexes;
- connection saturation and queueing;
- vacuum lag, dead tuples, and bloat;
- high WAL from write-heavy changes.

## Safe diagnostic SQL examples

These are examples to adapt after checking permissions and load. Avoid exposing sensitive query text or parameters.

```sql
-- Current activity (requires suitable privileges)
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS query_age,
       left(query, 300) AS query_sample
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start;
```

```sql
-- Aggregate query stats (requires pg_stat_statements)
SELECT calls, mean_exec_time, total_exec_time,
       rows, shared_blks_hit, shared_blks_read,
       left(query, 300) AS query_sample
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

These queries may expose query text and operational details. Redact before sharing. Availability and column names can vary by PostgreSQL/extension version.

## PostGIS note

For spatial queries, inspect geometry type, SRID, predicate, index type (often GiST), and whether the query expression is index-compatible. Compare `ST_Intersects`, `ST_DWithin`, geography vs geometry, transforms, and bounding-box filtering in the actual plan. Never suggest a spatial index without confirming query semantics and data distribution.
