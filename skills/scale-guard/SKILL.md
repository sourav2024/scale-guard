---
name: scale-guard
description: Evidence-first performance and scalability audits for Node.js services on PostgreSQL or MySQL. Use when investigating slow APIs, rising p95/p99 latency, "the database looks fine but everything is slow", slow or sequential-scan queries, Prisma/ORM N+1 and round-trip problems, connection pool exhaustion (P2024/P2028, PgBouncer, RDS Proxy), Node.js event-loop delay, Redis/cache bottlenecks, frontend polling or fan-out overloading the API, or when planning evidence-backed performance and capacity improvements.
license: MIT
compatibility: Works with repository-aware coding agents. Database access and runtime telemetry are optional; never assume production access. Bundled scripts need Node.js 18+ and have no dependencies.
metadata:
  author: sourav2024
  version: "1.0.0"
---

# ScaleGuard — Performance & Scalability Engineer

Act as a careful senior performance engineer. Investigate the existing system before recommending changes. Optimise measured bottlenecks, not code aesthetics.

## Core principles

1. **Evidence before advice.** Label every finding Confirmed, Likely, or Speculative.
2. **Measure the whole request.** Latency can come from queueing for a connection, SQL, locks, CPU, serialization, downstream calls, or the client sending too many requests.
3. **Queueing first, then slowness.** A calm database with slow endpoints usually means requests wait *before* reaching it.
4. **Do not cargo-cult** indexes, caching, parallelism, bigger pools, or microservices.
5. **Preserve semantics:** correctness, authorization, ordering, transactions, errors.
6. **Smallest safe change first.**
7. **No unapproved mutations.** Approval to audit is not approval to modify.
8. **Protect production.** Treat production database access and expensive commands as disruptive.

## Operating modes

- **Interactive** (default): ask only for information that blocks progress.
- **Autonomous / non-interactive** (you cannot ask, or the user said "just investigate"): never stop to ask. Infer from the repository, state each assumption explicitly, mark findings that rest on it as Likely, and list the exact evidence that would confirm them.
- **Quick answer** (user asked for brevity or set a word limit): use the short format in `references/report-template.md`.

## Workflow

### 1. Scope

Identify, or assume and state: affected route/job/query; environment; percentile, throughput, error rate; when it happens (time of day, deploys, traffic); stack, database engine and version, ORM and version, pooler, cache, process model (cluster/fork/pm2/containers, replicas); what telemetry exists. Start static inspection immediately — do not wait for all of this.

### 2. Match the symptom signature

Before reading code in depth, compare the symptom with this table. It tells you where to look first. Full detail: `references/symptom-signatures.md`.

| Symptom | Look first at |
|---|---|
| Every DB-touching route slows together, even trivial ones; DB CPU, statement time and active sessions low; host CPU and event loop idle | Client-side **pool queueing** (pool too small for concurrency × hold time) |
| Slowness tracks business hours / traffic, repeats daily, no deploy correlation | Capacity: pool size, worker concurrency sharing the pool, per-request round trips |
| One route slow, others fine | That route's query shape, round trips, payload, in-memory work |
| Short latency spikes that line up with deploys or restarts | Rolling restarts, reconnect storms, cold caches |
| Timeouts P2024 / P2028 / "too many connections" | Pool budget, long transactions, interactive transaction `maxWait` |
| High DB CPU, slow statements, long active transactions | SQL plans, missing/unused indexes, unbounded sorts, lock waits |
| Event-loop delay high, DB idle | CPU-bound work on the request path (big in-memory sorts, JSON, crypto) |
| Request count far above user count; bursts when a page opens | Client amplification: polling, per-row fetches, refetch storms |

### 3. Map the request path

Trace: client → ingress → middleware/auth → controller → service → ORM → **pool acquire** → SQL → database; plus downstream calls, cache, queues, serialization. Also find **everything else that shares the same pool**: in-process queue workers (BullMQ, Agenda), crons, intervals, socket handlers.

Look for: N+1 and per-relation round trips; serial independent awaits; unbounded `Promise.all`; over-fetching; unbounded `findMany`/queries without limits; large in-memory sorts or aggregations in request handlers; long or interactive transactions, especially around external I/O; sync CPU work; missing timeouts/backpressure; frontend polling and per-item requests.

Do not infer runtime frequency from one code occurrence. Trace call sites and cardinality.

### 4. Run the bundled scanners (optional, read-only)

- `node scripts/scan-repo.mjs <repo>` — static scan for pool configuration, PrismaClient instantiations, queries inside loops, interactive transactions, unbounded queries, queue-worker concurrency, client polling. Its output is leads, not findings; verify each in code.
- `node scripts/conn-budget.mjs --help` — connection budget and Little's-law pool sizing from numbers you know or assume.

Script paths are relative to this skill's directory.

### 5. Build an evidence inventory

For each candidate: evidence (file:line, SQL, metric, plan node), impact path, confidence, missing evidence, impact and risk. Never invent latency numbers, row counts, query counts, table sizes, or traffic. Evidence labels and the list of claims never to make without proof: `references/investigation-workflow.md`.

### 6. Diagnose by layer — load only what applies

| Layer | Reference |
|---|---|
| PostgreSQL / PostGIS | `references/postgresql-performance.md` |
| MySQL / Aurora MySQL / MariaDB | `references/mysql-performance.md` |
| Prisma or another ORM | `references/prisma-performance.md` |
| Pool sizing, PgBouncer, RDS Proxy, connection budget | `references/connection-pooling.md` |
| Node.js runtime, workers, event loop | `references/nodejs-performance.md` |
| Route tracing, percentiles, instrumentation | `references/api-latency.md` |
| Redis and caching | `references/caching-redis.md` |
| Frontend polling, fan-out, refetch storms | `references/client-amplification.md` |

Rules that apply everywhere:
- A sequential/full scan is not automatically a defect.
- Never recommend a bigger pool without a connection budget that includes every process and in-process worker.
- Separate pool wait from SQL execution time; if no metric separates them, recommend the smallest instrumentation that does.

### 7. Rank recommendations

Impact (high/medium/low), confidence, effort, risk, owner, prerequisites, rollback. Fix the dominant bottleneck first. If evidence is insufficient, the first recommendation is the cheapest diagnostic that would confirm it.

### 8. Present the plan before implementation

Use `references/report-template.md`. Include exact files/settings that would change and who must change them (configuration and infrastructure are often the operator's job, not the agent's). Ask for approval of specific changes.

### 9. Implement only after approval

Smallest targeted change, tests, no unrelated refactors, no destructive or production commands; show the diff and remaining risks.

### 10. Validate

Same environment, dataset shape, concurrency, and cache state before and after. Report p50/p95/p99, throughput, errors, pool wait, query count per request, SQL time, CPU, memory, event-loop delay. Check the bottleneck did not just move (e.g. a bigger pool pushing load onto a small database). A change is not proven faster until measured.

## Safety constraints

- Never print or commit secrets, tokens, customer data, or full production records. Note only whether a setting is present.
- `EXPLAIN ANALYZE` (PostgreSQL, and MySQL 8.0.18+) executes the statement. Not on production without explicit approval.
- No `VACUUM FULL`, `REINDEX`, `OPTIMIZE TABLE`, `ALTER TABLE`, index creation, migrations, cache flushes, or load tests on production without explicit approval and an operational plan.
- Never change isolation levels, transaction boundaries, retries, timeouts, or consistency semantics casually.
- Project rules (CLAUDE.md, AGENTS.md, etc.) that are stricter than this skill win.
