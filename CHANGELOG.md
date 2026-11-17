# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-17

### Fixed

- `scan`: literal database URLs in `schema.prisma` were printed with credentials; they are now redacted.
- `scan`: the code line printed with each lead could contain credentials (e.g. `new Pool({ connectionString: "postgres://user:pass@…" })`, Dockerfile `CMD`, package.json scripts). URL passwords and `password=`/`token=`-style values are now redacted.
- `scan`: a repo under any folder named `test`/`tests`/`e2e` scanned 0 files (test-folder exclusion was applied to the absolute path). Windows paths are normalised too.
- `scan`: missed N+1 in `this.prisma.x.op()`, raw `pool.query`/`conn.execute`, and `Promise.all(xs.map(x => prisma…))` without `async`.
- `scan`: a missing path printed a clean "0 files" report; it now exits 2. `--limit` is validated.
- `budget`: unknown tier keys (`replica=3`) were silently ignored and produced a budget that was too low. They are now errors, as are non-numeric options.
- CLI: `--dir`/`--agent` without a value crashed with a stack trace.

### Changed

- `scan` reads only `.env.example`/`.sample`/`.template` by default; real `.env` files require `--include-env`.
- Scheduled jobs are detected by import (node-cron under any alias, cron, node-schedule, croner, Agenda, BullMQ `upsertJobScheduler`/`every`/`pattern`, `@nestjs/schedule`).
- Queue processors passed by name, wrapped in a call, or given as a file path are resolved (same file or relative import, two hops) to decide DB use: `uses DB`, `likely`, `no DB call found`, or `not resolved`. NestJS `@Processor` classes are recognised.
- Less noise: duplicate hits from nested loops are merged (`nested ×N`); `findMany` with an `in:` list or a unique-key filter is treated as bounded and the rest are ranked by whether the model grows per tenant (from `schema.prisma`, or `--hot-models`); cursor/skip loops are labelled batched pagination; interactive transactions are ranked by loops and query count; `setInterval` is reported only when it fetches; commented-out code is ignored everywhere; type declarations are no longer pool settings; `playwright-report`, `test-results`, `storybook-static`, `public`, `generated` folders and minified files are skipped.
- Every lead has a severity (high/medium/low) and a deployable; output has a per-deployable table. Script/seed code is ranked last and downgraded.

### Added

- `scan`: telemetry, process model (pm2 `instances`/`exec_mode`, `-i` in scripts, `NODE_APP_INSTANCE`, `cluster`, Dockerfile `CMD`, k8s/compose replicas, Procfile), pool sizes set via env vars, Prisma `$extends` query hooks and `transactionOptions`, socket handlers that query the DB, Redis `KEYS` with patterns, ioredis clients without `commandTimeout`, uncapped `take`/`limit` from `req.query`/`req.body`/`@Query`, RTK `pollingInterval` without `skipPollingIfUnfocused`, per-row polling components.
- `scan --changed-since <ref>` (PR mode, merge-base diff plus uncommitted and untracked files) and `--fail-on high|medium|low` exit codes for CI.
- `scan --include/--exclude <glob>`, `--hot-models`, and `// scale-guard-ignore: <reason>` suppressions.
- `budget --from-scan scan.json [--scan-tier name]` fills worker concurrency and client count from a scan.
- SKILL.md: look for existing telemetry (in the repo and through available MCP tools) before asking for metrics.
- Scanner fixture repository (`test/fixtures/scanner`) with a regression test per behaviour above.

## [1.0.0] - 2026-11-13

First public release.

### Added

- `scale-guard` Agent Skill: evidence-first workflow, approval gates, autonomous mode for agents that cannot ask questions, full and short report templates.
- Symptom-signature guide — "calm database, every route slow" points straight at client-side pool queueing.
- Reference guides: PostgreSQL/PostGIS, MySQL/Aurora MySQL, Prisma (default pool formula, `pool_timeout`, P2024/P2028, interactive-transaction defaults, `relationLoadStrategy`, pool metrics), connection budgets and Little's-law sizing including in-process workers, Node.js runtime, API latency, caching/Redis, client amplification.
- `scan-repo.mjs`: zero-dependency, read-only static scan for pool configuration, PrismaClient instances, queue-worker concurrency, global middleware, interactive transactions with external I/O, queries in loops, unbounded `findMany`, in-memory sorts, client polling. Never prints secret values.
- `conn-budget.mjs`: connection budget across process types, Prisma default pool, Little's-law demand, largest safe pool per process.
- `npx scale-guard` CLI (`install`, `scan`, `budget`, `path`), Claude Code plugin manifest, skills.sh layout.
- Evaluation pack: scenarios S1–S14, rubric, release gate, synthetic fixture repository.
