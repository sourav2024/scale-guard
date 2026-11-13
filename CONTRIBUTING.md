# Contributing to ScaleGuard

Thanks for helping. ScaleGuard's value is that its advice is **correct and evidence-backed**, so the bar for guidance changes is accuracy, not volume.

## Ground rules

- **No private data.** Never include real hostnames, company or customer names, credentials, query text with literals, or production metrics from an employer. Use synthetic fixtures or redacted, anonymised examples.
- **Version-qualify claims.** "Prisma ≤ 6 defaults to `physical_cpus * 2 + 1`" is useful; "Prisma defaults to 5" is not. Link the official docs in your PR.
- **Keep SKILL.md short.** It loads into the agent's context on every activation. Put depth in `skills/scale-guard/references/` and link it from SKILL.md (the validator fails on unlinked references).
- **Scripts stay zero-dependency** and read-only. They must never print environment values or file contents beyond one trimmed line per hit.

## Layout

```text
skills/scale-guard/SKILL.md        entry point (frontmatter + workflow)
skills/scale-guard/references/     guides loaded on demand
skills/scale-guard/scripts/        scan-repo.mjs, conn-budget.mjs
bin/cli.mjs                        npx scale-guard
evaluations/                       scenarios, evals.json, fixtures
test/                              node:test suites
tools/validate-skill.mjs           spec + version + link checks
```

## Development

```bash
git clone https://github.com/sourav2024/scale-guard
cd scale-guard
npm run verify          # validator + tests, no install needed
node bin/cli.mjs scan evaluations/fixtures/pool-queue-app
```

Try the skill locally with `node bin/cli.mjs install --dir <your-agent-skills-dir> --force`.

## Adding a symptom signature

1. Add it to `references/symptom-signatures.md` (you see / it means / confirm / wrong turn).
2. If it changes where to look first, add one row to the table in SKILL.md.
3. Add a scenario to `evaluations/scenarios.md` and, if possible, `evals.json`.
4. If a scanner rule can find a lead for it, add the rule and a test.

## Releasing

Maintainer-only: see [docs/releasing.md](docs/releasing.md).
