# Releasing

Maintainer notes for cutting a release.

## One-time setup

- [ ] **npm account** — `npm login` (username `sourav28`); check with `npm whoami`.
- [ ] **GitHub repo** at `github.com/sourav2024/scale-guard` with `origin` set.
- [ ] **`NPM_TOKEN`** repository secret (Automation token).
- [ ] **`release` environment** created (Settings → Environments).
- [ ] **Discussions enabled** — linked from SUPPORT.md and the issue templates.
- [ ] **Private vulnerability reporting enabled** (Settings → Security).
- [x] **GitHub Sponsors** listing is live at <https://github.com/sponsors/sourav2024>. It is wired up in `.github/FUNDING.yml` (Sponsor button), `package.json` `funding` (`npm fund`), the README badge and "Support this project" section, and the CLI's install message.
- [ ] Repo topics: `agent-skills`, `claude-code`, `performance`, `scalability`, `prisma`, `postgresql`, `mysql`.

## Pre-flight

```bash
npm run verify
npm pack --dry-run     # only bin/, skills/, .claude-plugin/, README, CHANGELOG, LICENSE
```

- [ ] `CHANGELOG.md` has the version entry; `## [Unreleased]` is empty.
- [ ] `package.json`, `.claude-plugin/plugin.json` and SKILL.md `metadata.version` agree (the validator enforces this).
- [ ] Re-read every changed guide for private data (hostnames, company names, real production numbers).

## Publish

```bash
git tag v1.0.0
git push origin main --tags
```

`release.yml` checks versions, runs verification, publishes to npm with provenance, and creates the GitHub release from the changelog.

## After publishing

- [ ] `npx scale-guard@latest --version` prints the new version.
- [ ] `npx skills add sourav2024/scale-guard --list` shows the skill (skills.sh indexes public GitHub repos; installs make it appear on the leaderboard).
- [ ] In Claude Code: `/plugin marketplace add sourav2024/scale-guard`, then `/plugin install scale-guard@scale-guard`.
- [ ] Optional listings: awesome-agent-skills lists, Agensi (upload a zip with SKILL.md at the root: `cd skills && zip -r ../scale-guard.zip scale-guard`).
