# MySQL / Aurora MySQL Performance Guide

Applies to MySQL 8.x, Aurora MySQL 3 (8.0-compatible), and, with differences noted, MariaDB. Verify the exact version before relying on a feature.

## Evidence to collect (read-only)

- version (`SELECT VERSION()`), instance class, `max_connections`;
- connection usage: `SHOW GLOBAL STATUS LIKE 'Threads_%'` (`Threads_connected`, `Threads_running`), `Max_used_connections`, `Aborted_connects`;
- Aurora/RDS CloudWatch: `DatabaseConnections`, `CPUUtilization`, `DBLoad` (average active sessions), `CPUCreditBalance` on burstable (t3/t4g) classes;
- top statements: `performance_schema.events_statements_summary_by_digest` ordered by `SUM_TIMER_WAIT`;
- slow query log settings (`slow_query_log`, `long_query_time`);
- table definitions and indexes: `SHOW CREATE TABLE`, `SHOW INDEX FROM`.

Prefer digests and aggregates over raw statement text. Redact literals before sharing.

## Reading the signals

- `Threads_connected` flat at an exact round number during slow windows → the clients' pool ceiling, not the server limit. Compare with `processes × pool size`.
- `Threads_running` low while the API is slow → work is not reaching MySQL; look at client-side queueing.
- `DBLoad` well below vCPU count and low statement latency → the database is not the bottleneck.
- Burstable instance with credit balance falling to zero → CPU throttling; a capacity issue, not a query issue.

## EXPLAIN

- `EXPLAIN` estimates only and does not execute. `EXPLAIN FORMAT=TREE` gives the iterator tree (8.0.16+).
- `EXPLAIN ANALYZE` (8.0.18+) **executes** the query. Same safety rules as PostgreSQL.
- In tabular output check: `type` (`ALL` = full scan, `index` = full index scan, `range`, `ref`, `eq_ref`, `const`), `key` vs `possible_keys`, `rows` × `filtered`, and `Extra` (`Using filesort`, `Using temporary`, `Using index` = covering, `Using where`).
- A full scan (`type: ALL`) on a small table or one returning most rows can be optimal, as in PostgreSQL.

## Index notes specific to InnoDB

- The primary key is the clustered index. Secondary indexes store the primary key, so a wide primary key widens every index.
- A composite index serves the leftmost prefix. Equality columns first, then the range or `ORDER BY` column, is a common starting point, not a universal rule.
- `ORDER BY ... LIMIT` can avoid a filesort only if an index matches the filter and order columns.
- Functions on indexed columns, implicit type conversion (comparing a string column with a number), and collation mismatches disable index use. Functional indexes exist from 8.0.13.
- Index creation on large tables: online DDL (`ALGORITHM=INPLACE, LOCK=NONE`) still costs I/O and replication lag; plan it with the operator.

## Pagination and sorting

- Large `OFFSET` scans and discards rows. Keyset pagination needs a deterministic order with a unique tie-breaker.
- Sorting by a value computed in application code forces reading every candidate row into memory. Prefer a stored, indexed sort column or a bounded candidate set.

## Transactions and locks

- InnoDB default isolation is REPEATABLE READ; long transactions keep old row versions (history list length) and hold locks.
- Inspect `information_schema.innodb_trx` (age, `trx_rows_locked`), `performance_schema.data_lock_waits` (8.0), and `innodb_lock_wait_timeout`.
- Gap locks under REPEATABLE READ can block inserts unrelated in application terms.

## Connections

- Each MySQL connection is a thread with per-connection buffers. Raising `max_connections` costs memory.
- Aurora MySQL's default `max_connections` is derived from instance memory; small classes allow far fewer than large ones. Check the parameter group rather than assuming.
- RDS Proxy can multiplex connections but pins sessions that use session state (temporary tables, `SET` variables, some prepared-statement patterns).

## Safe diagnostic SQL examples

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN
  ('Threads_connected','Threads_running','Max_used_connections','Aborted_connects');
```

```sql
SELECT DIGEST_TEXT, COUNT_STAR,
       ROUND(AVG_TIMER_WAIT/1e9, 2)  AS avg_ms,
       ROUND(SUM_TIMER_WAIT/1e12, 2) AS total_s,
       SUM_ROWS_EXAMINED, SUM_ROWS_SENT
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 20;
```

```sql
SELECT trx_id, trx_state, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s,
       trx_rows_locked, trx_rows_modified
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 20;
```

A high `SUM_ROWS_EXAMINED / SUM_ROWS_SENT` ratio is a strong lead for an indexing or query-shape problem.
