#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, "skills", "scale-guard");
const errors = [];
const fail = (m) => errors.push(m);

const src = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
if (!fm) fail("SKILL.md has no YAML frontmatter");
const meta = {};
for (const line of (fm?.[1] ?? "").split("\n")) {
  const m = /^([a-z-]+):\s*(.*)$/.exec(line);
  if (m) meta[m[1]] = m[2].replace(/^"|"$/g, "");
}
const version = /^\s+version:\s*"?([^"\n]+)"?/m.exec(fm?.[1] ?? "")?.[1];

if (!meta.name) fail("name is required");
if (meta.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name)) fail("name must be lowercase letters, digits and single hyphens");
if (meta.name && meta.name.length > 64) fail("name must be at most 64 characters");
if (meta.name !== basename(SKILL_DIR)) fail(`name "${meta.name}" must match directory "${basename(SKILL_DIR)}"`);
if (!meta.description) fail("description is required");
if (meta.description && meta.description.length > 1024) fail(`description is ${meta.description.length} chars (max 1024)`);
if (meta.compatibility && meta.compatibility.length > 500) fail("compatibility must be at most 500 characters");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
if (version !== pkg.version) fail(`SKILL.md metadata.version ${version} != package.json ${pkg.version}`);
if (plugin.version !== pkg.version) fail(`plugin.json version ${plugin.version} != package.json ${pkg.version}`);

const bodyLines = src.slice(fm?.[0].length ?? 0).split("\n").length;
if (bodyLines > 500) fail(`SKILL.md body is ${bodyLines} lines (keep under 500)`);

for (const m of src.matchAll(/`((?:references|scripts)\/[\w.-]+)`/g)) {
  if (!existsSync(join(SKILL_DIR, m[1]))) fail(`SKILL.md references missing file ${m[1]}`);
}
const refs = readdirSync(join(SKILL_DIR, "references"));
for (const r of refs) if (!src.includes(`references/${r}`)) fail(`references/${r} is never mentioned in SKILL.md`);

if (errors.length) {
  for (const e of errors) process.stderr.write(`✖ ${e}\n`);
  process.exit(1);
}
process.stdout.write(`✔ ${meta.name} ${version}: frontmatter valid, ${refs.length} references linked, ${bodyLines} body lines\n`);
