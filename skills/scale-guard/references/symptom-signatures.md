# Symptom Signatures

Recognising the shape of a slowdown narrows the search more than any single metric. Each signature lists what you see, what it usually means, how to confirm it, and the common wrong turn.

## 1. Client-side pool queueing

**You see:** every route that touches the database slows by a similar amount, including trivial ones (an auth check doing one primary-key lookup). Database CPU, average statement time, active sessions, and slow-query logs stay calm. Host CPU and event-loop delay are fine. Often no errors, because waits stay under the pool timeout.

**It means:** requests are waiting in the application's connection pool before any SQL runs. The database never sees that time.

**Confirm:**
- database connection count flat at exactly `processes × pool size` during the slow window (a ceiling, not a curve);
- pool metrics (busy/idle/wait) if exported; for Prisma, the `metrics` feature;
- the cheapest DB-touching route's p95 rising with traffic — use it as a canary;
- pool-timeout errors (Prisma P2024, `pg-pool` "timeout exceeded when trying to connect", `mysql2` "Queue limit reached").

**Wrong turn:** adding indexes, tuning SQL, or scaling the database instance. The database is not the constraint.

## 2. Capacity curve, not regression

**You see:** degradation every business day at the same hours, for weeks; no correlation with deploys.

**It means:** demand crosses a fixed limit (pool size, worker concurrency, CPU credits on burstable instances, rate limits).

**Confirm:** overlay p95 with request rate and connection count over several days. Check burstable-instance credit balance.

**Wrong turn:** bisecting recent commits.

## 3. Shared pool starvation by background work

**You see:** signature 1 or 2, worse when queues are busy (email, webhooks, document parsing, syncs).

**It means:** in-process workers, crons, and socket handlers share the request pool. Their combined concurrency can exceed the pool on their own.

**Confirm:** list every worker with its concurrency; sum the connections they can hold; look for interactive transactions with long timeouts inside jobs.

**Fix direction:** separate process for workers with its own small pool, or cap worker concurrency below pool size.

## 4. One heavy route

**You see:** one route slow at p95, others fine; the route's latency grows with tenant size.

**It means:** query shape — many round trips per request (ORM includes), unbounded reads, large in-memory sorts/aggregations, wide payloads.

**Confirm:** query count per request in a non-production environment; payload size; row counts returned.

## 5. Deploy blips

**You see:** short multi-second latency spikes on each instance in turn during a rollout, occasional pool or connection timeouts, socket reconnect storms.

**It means:** rolling restart without draining, cold pools and caches, all clients reconnecting at once.

**Confirm:** align spikes with process start log lines.

**Fix direction:** drain before restart, readiness checks, jittered client reconnects, alert `for` durations so a single blip does not page.

## 6. Long transactions and lock waits

**You see:** transaction-timeout errors (P2028), lock-wait timeouts, long-running active transactions, pool exhaustion following one slow job.

**It means:** connections held across external I/O, unbounded statements inside transactions, or row/table locks.

**Confirm:** `pg_stat_activity` (`xact_start`, `wait_event`) or MySQL `information_schema.innodb_trx` and `performance_schema.data_lock_waits`.

## 7. Database-bound

**You see:** high database CPU or I/O, slow-query log entries, statements with high mean time.

**It means:** genuine SQL cost — plans, indexes, sorts, spills, bloat.

**Confirm:** `pg_stat_statements` / MySQL `performance_schema.events_statements_summary_by_digest`, then plans for the top statements.

## 8. Event-loop bound

**You see:** event-loop delay p99 elevated, CPU high on one core, the database idle, all routes on that process slow.

**It means:** synchronous CPU work on the request path — large in-memory sort of thousands of rows, JSON stringify of large payloads, sync crypto/compression, regex backtracking.

**Confirm:** CPU profile in a representative environment.

## 9. Client amplification

**You see:** request rate grows faster than active users; bursts when a specific page opens; the same endpoint called with many ids in quick succession.

**It means:** frontend polling per card/row, per-item detail requests, refetch-everything on each realtime event, retries without backoff.

**Confirm:** count requests per page view in a browser session; group server logs by user and route per minute.

See `client-amplification.md`.
