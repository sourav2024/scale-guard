# Connection Pools, Budgets, and Proxies

Applies to PostgreSQL (PgBouncer, RDS Proxy, Supavisor) and MySQL (RDS Proxy, ProxySQL).

## 1. Build the connection budget

Count every client that can hold a connection at the same moment:

```
total = Σ over every process type (replicas × processes_per_replica × pool_max)
      + migration / admin / BI / monitoring connections
      + other services sharing the database
```

Include process types people forget:
- in-process queue workers (BullMQ, Agenda, Bee) and their **combined concurrency** — a worker with concurrency 10 that runs queries can want up to 10 connections from the same pool;
- crons, intervals, and socket handlers in the API process;
- separate worker services, scripts, and other applications using the same database;
- a second PrismaClient (e.g. a read-only or jobs client) in the same process.

Compare `total` with the server limit (`max_connections` minus reserved slots) and keep 20–30 % headroom.

`node scripts/conn-budget.mjs` does this arithmetic.

## 2. Size the pool from demand (Little's law)

```
busy_connections ≈ queries_per_second × average_connection_hold_seconds
```

Example: 400 queries/s on a node, each holding a connection ~4 ms → 1.6 busy connections on average. Add margin for bursts (×2–4) and for long holders (interactive transactions, slow jobs), which dominate when present.

If the demand exceeds the pool, requests queue. If it is far below, raising the pool will not help — look elsewhere.

Hold time is not statement time: it includes network round trip for every statement and the full duration of interactive transactions.

## 3. Diagnose saturation

Separate: waiting to acquire from the application pool; proxy client queueing and server wait; database execution; lock waits; network.

Signals: pool busy/idle/waiting counts, acquire-latency histogram, database connection count (flat at the pool ceiling = saturation), transaction duration, proxy stats (`SHOW POOLS`, `SHOW STATS` for PgBouncer).

## 4. Choosing a fix

| Situation | Direction |
|---|---|
| Pool ceiling hit, database idle, budget has room | Raise pool size per process within budget; set it explicitly instead of relying on a CPU-derived default |
| Budget has no room | Pooler/proxy, fewer processes, or reduce hold time |
| Background jobs share the pool | Separate process with its own small pool, or cap concurrency |
| Long transactions dominate | Shorten them; move external I/O out; lower their timeouts |
| Many round trips per request | Fewer queries per request; lowers hold time per request |
| Burstable DB instance near credit exhaustion | A bigger pool pushes more load onto it; check CPU credits first |

Raising the pool moves load to the database. Verify database CPU, credits, and statement latency after the change.

## PgBouncer cautions

Transaction pooling affects session state, prepared statements, temporary tables, advisory locks, and `SET` commands depending on versions. Verify ORM compatibility in the official docs for the versions in use.

## RDS Proxy / ProxySQL cautions

Session pinning (temporary tables, session variables, some prepared statements) defeats multiplexing; check pinning metrics. Proxies add a little per-query latency.
