# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
