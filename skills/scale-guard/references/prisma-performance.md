# Prisma and ORM Performance Guide

Verify the installed Prisma version (`package.json`, lockfile) before relying on any option below; defaults and preview features change between major versions.

## Connection pool (Prisma's built-in pool, Prisma ≤ 6)

- Pool size comes from `connection_limit` in the datasource URL. **If it is absent, the default is `num_physical_cpus * 2 + 1`.** A 4-vCPU VM often has 2 physical cores, giving **5** connections per PrismaClient.
- `pool_timeout` (default 10 s) is how long a query waits for a free connection before failing with **P2024**. Waits shorter than that produce no error and no log — they only show as latency.
- Each `new PrismaClient()` has its own pool. One per process is normal; one per request or per module import is a leak.
- Every process (cluster worker, pm2 instance, container replica, separate worker service) multiplies the pool.
- With driver adapters (default in Prisma 7), pooling belongs to the driver (`pg`, `mariadb`, etc.); read the adapter's pool settings instead.

- The CPU count is what the Prisma engine detects at runtime; inside containers with CPU limits it may differ from the host's. Treat the derived number as an estimate.
- If the Prisma version cannot be determined (no `package.json` or lockfile in scope), state both possibilities — built-in pool (≤ 6) or driver pool (7 / adapters) — and make "confirm the version" the first diagnostic step.

Where to look: the PrismaClient construction file, `schema.prisma` `datasource`, environment-variable usage, deployment config. If production env files are not in the repository, say so and mark the pool size as inferred.

## Interactive transactions

- `prisma.$transaction(async (tx) => ...)` holds one connection for the whole callback.
- Defaults: `maxWait` 2 s (time to acquire a connection), `timeout` 5 s (time the transaction may run). Exceeding either raises **P2028**.
- External HTTP calls, file I/O, or large loops inside the callback hold a connection idle. Under load this starves the pool.
- The array form `$transaction([q1, q2])` is shorter-lived and preferable when no logic runs between queries.

## Query shape

### Round trips from `include`
By default Prisma loads each relation level with a separate query. A wide `include` tree on a list endpoint can mean 20–40 statements per request, each acquiring a pool connection in turn.

Options:
- trim `include`/`select` to the fields the caller renders;
- `relationLoadStrategy: "join"` (the `relationJoins` preview feature on Prisma 5.8+; PostgreSQL and MySQL 8.0.14+) loads relations in one query using lateral joins / JSON aggregation. Measure: fewer round trips, but per-query cost and payload can grow for deep trees;
- split the list endpoint (lean list query) from the detail endpoint (full include).

### N+1
A loop running one query per parent. Verify with a query log or per-request query count. Remedies: `include`, batched `where: { id: { in: ids } }`, DataLoader, or an aggregate query.

### Over-fetching
`select` only needed fields; avoid large text/JSON columns in lists.

### Unbounded reads
`findMany` without `take` on tenant-scaled tables, especially to sort or aggregate in JavaScript. Bound it, push the work into SQL, or cache with a deliberate staleness budget.

### Serial awaits
Independent queries can run concurrently, but each concurrent query needs its own connection. On a small pool, parallelism can worsen queueing for other requests.

### Pagination
Prefer cursor pagination with a unique tie-breaker for deep pages. OFFSET is fine for shallow pages.

## Measuring

- **Query count per request:** `log: ['query']` or the `query` event in a non-production environment; count statements per request.
- **Pool wait:** the `metrics` preview feature (Prisma 3.x–6.x; removed in Prisma 7) exposes `prisma_pool_connections_busy`, `prisma_pool_connections_idle`, `prisma_client_queries_wait`, and `prisma_client_queries_wait_histogram_ms` via `$metrics.prometheus()` / `$metrics.json()`. Alternatively, OpenTelemetry tracing (`@prisma/instrumentation`) separates connection acquisition from execution in spans.
- Query logs contain SQL and possibly parameters. Never enable them in production without approval.

## Errors to recognise

| Code | Meaning | Usually |
|---|---|---|
| P2024 | Timed out fetching a connection from the pool | Pool too small for load, or connections held too long |
| P2028 | Transaction API error (often `maxWait`/`timeout` exceeded) | Long interactive transaction, or pool starved |
| P1001 / P1017 | Cannot reach server / connection closed | Network, restarts, proxy limits |

## PgBouncer / proxies

With PgBouncer in transaction mode, older Prisma versions need `pgbouncer=true` (prepared statements), and migrations need a direct URL. Check the docs for the installed version.

## Validation

Compare query count per request, rows fetched, pool wait, DB time, memory, and endpoint percentiles before and after. Add correctness tests for relation shape, ordering, nullability, and authorization.
