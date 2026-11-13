#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills", "scale-guard");
const SCRIPTS = join(SKILL, "scripts");

const TARGETS = {
  claude: { project: ".claude/skills", global: join(homedir(), ".claude", "skills") },
  codex: { project: ".agents/skills", global: join(homedir(), ".codex", "skills") },
  agents: { project: ".agents/skills", global: join(homedir(), ".agents", "skills") },
};

const HELP = `scale-guard — evidence-first performance & scalability audits for coding agents

Usage:
  npx scale-guard install [--agent claude|codex|agents] [--global] [--dir <path>] [--force]
  npx scale-guard scan <repo> [--limit N] [--json]
  npx scale-guard budget --tier <spec> [...]      (see: npx scale-guard budget --help)
  npx scale-guard path                            print the skill directory
  npx scale-guard --version

install copies the skill into <project>/.claude/skills/scale-guard by default.
`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return true;
}

function opt(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function install(args) {
  const agent = opt(args, "--agent") ?? "claude";
  const dir = opt(args, "--dir");
  const global = flag(args, "--global");
  const force = flag(args, "--force");
  const t = TARGETS[agent];
  if (!t && !dir) {
    process.stderr.write(`Unknown agent "${agent}". Use one of ${Object.keys(TARGETS).join(", ")} or --dir.\n`);
    return 1;
  }
  const base = dir ? resolve(dir) : global ? t.global : resolve(process.cwd(), t.project);
  const dest = join(base, "scale-guard");
  if (existsSync(dest)) {
    if (!force) {
      process.stderr.write(`${dest} already exists. Re-run with --force to replace it.\n`);
      return 1;
    }
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(base, { recursive: true });
  cpSync(SKILL, dest, { recursive: true });
  process.stdout.write(`Installed ScaleGuard to ${dest}\n`);
  process.stdout.write("If it helps you, consider sponsoring: https://github.com/sponsors/sourav2024\n");
  return 0;
}

function run(script, args) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "install":
      return install(args);
    case "scan":
      return run("scan-repo.mjs", args);
    case "budget":
      return run("conn-budget.mjs", args);
    case "-v":
    case "--version":
      process.stdout.write(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version + "\n");
      return 0;
    case "path":
      process.stdout.write(SKILL + "\n");
      return 0;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return cmd ? 0 : 1;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href || process.argv[1]?.endsWith("/scale-guard")) {
  process.exitCode = main();
}
