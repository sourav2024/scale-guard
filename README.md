# ScaleGuard

**Evidence-first performance and scalability audits for AI coding agents.**

[![CI](https://github.com/sourav2024/scale-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/sourav2024/scale-guard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/scale-guard.svg)](https://www.npmjs.com/package/scale-guard)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/sourav2024)

ScaleGuard is an [Agent Skill](https://agentskills.io) that turns a coding agent into a careful performance engineer for Node.js services on **PostgreSQL or MySQL** — Express/NestJS, Prisma, Redis, PgBouncer, RDS Proxy. It traces the real request path in your repository, matches the symptom to a known signature, separates measured facts from hypotheses, and proposes the smallest safe fix with a validation plan. It changes nothing without your approval.

The pattern it is built to catch first is one of the most common and most misdiagnosed: **every endpoint gets slow at peak while the database dashboards look idle.** That is usually requests queueing for an undersized application connection pool — often an ORM default — shared with background jobs. Teams lose weeks tuning SQL that was never the problem.

## What it catches

| Signature | Example tell |
|---|---|
| Client-side pool queueing | Every route slow, even a one-row auth check; database calm |
| Shared pool starvation | Queue workers in the API process with combined concurrency > pool size |
| Long transactions | `$transaction(async …)` that awaits an HTTP call |
| Round-trip explosion | Wide Prisma `include` trees on list endpoints (20–40 statements per request) |
| Unbounded in-memory work | `findMany` with no `take`, then `.sort()` in JavaScript |
| Client amplification | Per-row polling, refetch-everything on every socket event |
| Deploy blips, event-loop blocking, real SQL cost | …with the evidence needed to tell them apart |

## Install

**Any agent (skills.sh):**
```bash
npx skills add sourav2024/scale-guard
```

**npm CLI:**
```bash
npx scale-guard install                  # ./.claude/skills/scale-guard
npx scale-guard install --global         # ~/.claude/skills/scale-guard
npx scale-guard install --agent codex    # Codex
npx scale-guard install --dir <path>     # anywhere else
```

**Claude Code plugin:**
```
/plugin marketplace add sourav2024/scale-guard
/plugin install scale-guard@scale-guard
```

## Use

Ask your agent:

- "Every endpoint gets slow in the afternoon but the database looks fine. Why?"
- "Audit this service for API latency and scalability risks."
- "Review our Prisma usage for N+1 queries and connection pool pressure."
- "Trace the slow `/api/orders` endpoint and give me a prioritised plan."
- "Review this EXPLAIN ANALYZE output."

## Bundled tools (zero dependencies, read-only)

```bash
npx scale-guard scan ./my-service
```
Static scan for leads: PrismaClient instances, pool settings (never prints secret values), queue-worker concurrency, interactive transactions with external I/O, queries in loops, unbounded `findMany`, in-memory sorts, client polling. Request-path code is ranked first.

```bash
npx scale-guard budget --tier name=api,replicas=3,vcpus=4,workers=70 --max-connections 90 --reserved 10
```
Connection budget across every process type, Prisma's default pool size, Little's-law demand, and the largest safe pool per process.

## Safety model

ScaleGuard is read-only during discovery and diagnosis. It will not run load tests against production, run `EXPLAIN ANALYZE` on production without explicit approval, change schemas, indexes, code, infrastructure or configuration without approval, expose secrets, or claim a fix worked without before/after measurements. Project rules that are stricter (CLAUDE.md, AGENTS.md) take precedence.

## Layout

```text
skills/scale-guard/
├── SKILL.md
├── references/      symptom signatures, PostgreSQL, MySQL, Prisma, pooling,
│                    Node.js, API latency, caching/Redis, client amplification,
│                    investigation workflow, report templates
└── scripts/         scan-repo.mjs, conn-budget.mjs
evaluations/         scenarios, rubric, synthetic fixture repository
test/                node:test suites for the scripts
```

## Development

```bash
npm run verify   # frontmatter/spec validation + tests
```

## Evaluation

See [`evaluations/`](evaluations/README.md): scenarios, a 0–30 rubric, a release gate, and a synthetic fixture repository with planted issues. 

## Contributing

Performance advice is only as good as its evidence. Contributions that add a reproducible scenario (a fixture or a redacted plan), the expected diagnosis, and a validation method are the most valuable. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Found a vulnerability?** Report it [privately](https://github.com/sourav2024/scale-guard/security/advisories/new) — please don't open a public issue.

## Support this project

ScaleGuard is free and MIT-licensed, and it stays that way. If it saved you a week of chasing the wrong bottleneck, you can [sponsor the work on GitHub](https://github.com/sponsors/sourav2024).

Things that help just as much and cost nothing: starring the repo, filing a good bug report, or telling me where the skill gave a wrong diagnosis.

## License

MIT. See [LICENSE](LICENSE).
