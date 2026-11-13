# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/sourav2024/scale-guard/security/advisories/new). Include a description, impact, reproduction steps, and the `scale-guard` and Node.js versions.

- Acknowledgement within 5 business days
- Assessment and fix timeline within 10 business days
- Credit in the release notes unless you prefer otherwise

This is a volunteer-maintained project; there is no paid bug bounty.

## Threat model

ScaleGuard is **instructions plus two local, read-only scripts**. It has no runtime dependencies, makes no network requests, and runs nothing on install.

| Component | What it does | Defences |
| --- | --- | --- |
| `SKILL.md` + references | Guide an agent's investigation | Require explicit approval before any mutation; forbid `EXPLAIN ANALYZE`, DDL, migrations, cache flushes and load tests on production without approval; forbid printing secrets or customer data |
| `scan-repo.mjs` | Reads source files under a path you give it | Read-only; skips `node_modules`, VCS and build dirs; files over 1.5 MB skipped; for `.env*` files reports only **whether** pool settings are present, never values; prints one trimmed line per hit |
| `conn-budget.mjs` | Arithmetic on numbers you pass | No file or network access |
| `bin/cli.mjs install` | Copies the skill into an agent skills directory | Refuses to overwrite an existing directory without `--force` |

Reports of the skill steering an agent into an unsafe action (for example running a mutating command on production without asking) are treated as security issues.
