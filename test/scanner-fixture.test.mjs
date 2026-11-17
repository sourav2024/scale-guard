import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, scanSource, globToRegExp } from "../skills/scale-guard/scripts/scan-repo.mjs";

// This fixture lives under a directory named "test": scanning it at all is the
// regression test for test-folder exclusion being applied to the absolute path.
const fixture = fileURLToPath(new URL("./fixtures/scanner", import.meta.url));
const r = scanRepo(fixture);
const by = (k) => r.hits.filter((h) => h.kind === k);
const at = (k, file) => by(k).filter((h) => h.file === file);
const kinds = (src, file = "src/a.ts") => scanSource(src, file).map((h) => h.kind);
const SCRIPT = fileURLToPath(new URL("../skills/scale-guard/scripts/scan-repo.mjs", import.meta.url));

test("repo under a folder named test is still scanned", () => {
  assert.ok(r.scanned >= 10, `scanned ${r.scanned}`);
});

test("literal database URLs in schema.prisma are redacted", () => {
  assert.equal(r.schemas[0].url, "<literal URL redacted>");
  assert.ok(!JSON.stringify(r).includes("S3cretPassw0rd"));
});

test("cron detected by import alias, BullMQ upsertJobScheduler detected once", () => {
  assert.deepEqual(by("scheduled-job").map((h) => h.via), ["node-cron", "bullmq"]);
});

test("named and wrapped queue processors are resolved across files", () => {
  assert.deepEqual(by("queue-worker").map((w) => [w.concurrency, w.usesDb]), [[5, true], [3, true], [2, false]]);
});

test("nested loops report one deduplicated lead", () => {
  const h = at("query-in-loop", "apps/api/src/routes/reports.ts").filter((x) => x.line === 16);
  assert.equal(h.length, 1);
  assert.equal(h[0].depth, 2);
});

test("this.prisma, raw pool.query and non-async Promise.all(map) are detected", () => {
  assert.ok(at("query-in-loop", "apps/api/src/routes/reports.ts").some((h) => h.line === 16));
  assert.ok(at("query-in-loop", "apps/api/src/routes/reports.ts").some((h) => h.line === 23));
  assert.ok(at("query-in-callback", "apps/api/src/routes/reports.ts").some((h) => h.parallel));
});

test("cursor loops are labelled batched pagination and rank low", () => {
  const h = by("query-in-loop").find((x) => x.loop === "while");
  assert.equal(h.batched, true);
  assert.equal(h.severity, "low");
});

test("findMany bounded by an in: list is not reported; tenant-scaled models rank first", () => {
  const f = by("unbounded-findMany");
  assert.ok(!f.some((h) => h.line === 37));
  assert.deepEqual(f.map((h) => h.model), ["load", "country"]);
  assert.equal(f[0].severity, "medium");
});

test("scale-guard-ignore silences a lead and records the reason", () => {
  assert.ok(!by("unbounded-findMany").some((h) => h.line === 40));
  assert.equal(r.ignored.length, 1);
  assert.match(r.ignored[0].reason, /reviewed/);
});

test("commented-out middleware is ignored", () => {
  assert.deepEqual(by("global-middleware").map((h) => h.middleware), ["auth"]);
});

test("generated, report and minified files are skipped", () => {
  assert.ok(!r.hits.some((h) => h.file.startsWith("playwright-report/")));
  assert.ok(!r.hits.some((h) => h.file.endsWith("vendor.js")));
  assert.equal(r.skipped.minified, 1);
});

test("type declarations are not pool settings; env-var pool sizes are named", () => {
  const p = by("pool-setting");
  assert.equal(p.length, 1);
  assert.equal(p[0].envVar, "GEO_POOL_MAX");
  assert.deepEqual(r.poolEnvVars, ["GEO_POOL_MAX"]);
});

test("setInterval is reported only when it fetches; RTK polling without skipPollingIfUnfocused flagged", () => {
  const c = by("client-polling");
  assert.ok(!c.some((h) => h.file.includes("Carousel")));
  assert.equal(c.length, 2);
  assert.ok(c.every((h) => h.perRow));
  assert.ok(c.some((h) => h.unfocused));
});

test("process model: pm2 instances, NODE_APP_INSTANCE gating, k8s replicas, Dockerfile", () => {
  const d = by("process-model").map((h) => h.detail).join(" | ");
  assert.match(d, /pm2 instances=4/);
  assert.match(d, /NODE_APP_INSTANCE/);
  assert.match(d, /replicas=3/);
  assert.doesNotMatch(d, /replicas=9/);
  assert.match(d, /Dockerfile CMD/);
});

test("Prisma $extends query hook and transactionOptions", () => {
  assert.equal(by("prisma-extension")[0].extraQueries, true);
  assert.match(by("prisma-client")[0].transactionOptions, /maxWait: 5000/);
});

test("socket handler with DB, Redis KEYS and ioredis without commandTimeout", () => {
  assert.deepEqual(by("socket-handler-db").map((h) => h.event), ["subscribe"]);
  assert.equal(by("redis-keys").length, 1);
  assert.equal(by("redis-no-timeout").length, 1);
});

test("uncapped take from req.query, Math.min-capped value is not", () => {
  const u = by("uncapped-take");
  assert.equal(u.length, 1);
  assert.equal(u[0].value, "limit");
});

test("telemetry is surfaced", () => {
  assert.deepEqual(by("telemetry").map((h) => h.tool).sort(), ["/metrics endpoint", "prom-client"]);
});

test("scripts are ranked after request-path code and downgraded", () => {
  const loops = by("query-in-loop");
  assert.equal(loops.at(-1).file, "scripts/seed.ts");
  assert.equal(loops.at(-1).severity, "medium");
});

test("include/exclude globs", () => {
  assert.ok(globToRegExp("apps/web").test("apps/web/src/a.tsx"));
  assert.ok(globToRegExp("**/*.tsx").test("apps/web/src/a.tsx"));
  assert.ok(!globToRegExp("apps/*/x.ts").test("apps/a/b/x.ts"));
  const web = scanRepo(fixture, { include: ["apps/web"] });
  assert.ok(web.hits.length && web.hits.every((h) => h.file.startsWith("apps/web/")));
  const noWeb = scanRepo(fixture, { exclude: ["apps/web/**"] });
  assert.ok(!noWeb.hits.some((h) => h.file.startsWith("apps/web/")));
});

test("--hot-models ranks a model first", () => {
  const x = scanRepo(fixture, { hotModels: ["country"] });
  assert.equal(x.hits.find((h) => h.kind === "unbounded-findMany").model, "country");
});

test("real .env files are read only with includeEnv, values never returned", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-env-"));
  writeFileSync(join(dir, ".env"), "export DATABASE_URL=postgres://u:hunter2@h/db?connection_limit=5\n");
  writeFileSync(join(dir, "a.ts"), "export {};\n");
  assert.equal(scanRepo(dir).env.length, 0);
  const withEnv = scanRepo(dir, { includeEnv: true });
  assert.equal(withEnv.env[0].hasConnectionLimit, true);
  assert.ok(!JSON.stringify(withEnv).includes("hunter2"));
});

test("missing path is an error", () => {
  assert.throws(() => scanRepo("/definitely/not/here"), /no such directory/);
});

test("--changed-since reports only new leads and --fail-on sets the exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-git-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export async function a(xs){ for (const x of xs) { await prisma.a.findUnique({ where: { id: x } }); } }\n");
  g("add", ".");
  g("commit", "-qm", "base");
  appendFileSync(join(dir, "src/a.ts"), "export async function b(xs){ for (const x of xs) { await prisma.b.findUnique({ where: { id: x } }); } }\n");
  const pr = scanRepo(dir, { changedSince: "main" });
  assert.equal(pr.hits.length, 1);
  assert.equal(pr.hits[0].line, 2);
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, dir, ...a], { encoding: "utf8" });
  assert.equal(run("--changed-since", "main", "--fail-on", "high").status, 1);
  g("add", ".");
  g("commit", "-qm", "two");
  assert.equal(run("--changed-since", "HEAD", "--fail-on", "high").status, 0);
  assert.equal(run("--changed-since", "no-such-ref").status, 2);
});

test("unit: Promise.all over a non-async map callback", () => {
  assert.deepEqual(kinds("await Promise.all(ids.map(id => prisma.user.findUnique({ where: { id } })))"), ["query-in-callback"]);
});

test("unit: pure array maps are not queries", () => {
  assert.deepEqual(kinds("const ids = rows.map((r) => r.id); for (const x of xs) { total += x.n; }"), []);
});

test("unit: NestJS @Processor and @Cron", () => {
  const src = "@Processor('mail', { concurrency: 4 })\nexport class P {\n  async process(job) {\n    await this.prisma.mail.update({ where: { id: 1 }, data: {} });\n  }\n}\nclass J { @Cron('0 * * * *') run() {} }";
  const h = scanSource(src, "src/p.ts");
  assert.deepEqual(h.find((x) => x.kind === "queue-worker"), { ...h.find((x) => x.kind === "queue-worker"), concurrency: 4, usesDb: true });
  assert.ok(h.some((x) => x.kind === "scheduled-job"));
});

test("unit: JS private fields are not mistaken for comments", () => {
  assert.deepEqual(kinds("class A { #run(xs) { for (const x of xs) { this.db.query('select 1'); } } }"), ["query-in-loop"]);
});

test("credentials in printed code lines are redacted", () => {
  const src = [
    'export const redis = new Redis("redis://:SuperSecretRedisPw@cache.internal:6379");',
    'export const pool = new Pool({ connectionString: "postgres://admin:S3cretPw@db.internal/app", max: 20 });',
    'export const prisma = new PrismaClient({ datasourceUrl: "postgresql://app:Hunter2@db/app?connection_limit=5&password=Pw9" });',
  ].join("\n");
  const out = JSON.stringify(scanSource(`import Redis from "ioredis";\n${src}`, "src/db.ts"));
  for (const s of ["SuperSecretRedisPw", "S3cretPw", "Hunter2", "Pw9"]) assert.ok(!out.includes(s), s);
  const dir = mkdtempSync(join(tmpdir(), "sg-leak-"));
  writeFileSync(join(dir, "Dockerfile"), 'CMD ["sh", "-c", "DATABASE_URL=postgres://u:DockPw@h/db node dist/server.js"]\n');
  writeFileSync(join(dir, "package.json"), '{"scripts":{"start":"DATABASE_URL=postgres://u:PkgPw@h/db pm2 start dist/a.js -i 4"}}\n');
  const r2 = JSON.stringify(scanRepo(dir));
  assert.ok(r2.includes("pm2 -i 4") && r2.includes("Dockerfile CMD"));
  assert.ok(!r2.includes("DockPw") && !r2.includes("PkgPw"));
});

test("YAML with long whitespace runs scans in linear time", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-yaml-"));
  writeFileSync(join(dir, "deploy.yaml"), "spec:\n" + "        \n".repeat(20000) + "  replicas: 3\n");
  const t = Date.now();
  const r2 = scanRepo(dir);
  assert.ok(Date.now() - t < 2000, `${Date.now() - t}ms`);
  assert.equal(r2.hits[0].detail, "replicas=3");
});

test("workers whose processor can't be followed are unknown, not 'no DB'", () => {
  const src = [
    'import { Worker } from "bullmq";',
    'new Worker("a", jobs.sendEmail, { concurrency: 50 });',
    'new Worker("b", this.handle.bind(this), { concurrency: 40 });',
    'new Worker("c", async (job) => this.orders.sync(job.data), { concurrency: 30 });',
    'new Worker("d", async () => {}, { concurrency: 1 });',
    "@Processor('orders', { concurrency: 25 })",
    "export class OrdersProcessor {",
    "  async process(job) {",
    "    await this.orders.reconcile(job.data);",
    "  }",
    "}",
  ].join("\n");
  const w = scanSource(src, "src/w.ts").filter((h) => h.kind === "queue-worker");
  assert.deepEqual(w.slice(2).map((h) => h.usesDb), ["unknown", false, "unknown"]);
  assert.ok(w[0].refs && w[1].refs, "member processors become refs, resolved at repo level");
  const dir = mkdtempSync(join(tmpdir(), "sg-w-"));
  writeFileSync(join(dir, "w.ts"), src);
  const r2 = scanRepo(dir).hits.filter((h) => h.kind === "queue-worker");
  assert.deepEqual(r2.map((h) => [h.concurrency, h.usesDb]).sort((a, b) => b[0] - a[0]), [[50, "unknown"], [40, "unknown"], [30, "unknown"], [25, "unknown"], [1, false]]);
});

test("--changed-since handles spaces, non-ASCII and untracked names; '+++' code lines are not headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-names-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  const loop = "export async function f(xs){ for (const x of xs) { await prisma.a.findUnique({ where: { id: x } }); } }\n";
  for (const n of ["plain.ts", "my file.ts", "café.ts"]) writeFileSync(join(dir, "src", n), "export {};\n");
  g("add", ".");
  g("commit", "-qm", "base");
  for (const n of ["plain.ts", "my file.ts", "café.ts"]) appendFileSync(join(dir, "src", n), loop);
  mkdirSync(join(dir, "src/new"));
  writeFileSync(join(dir, "src/new/ünt racked.ts"), loop);
  const files = scanRepo(dir, { changedSince: "main" }).hits.map((h) => h.file).sort();
  assert.deepEqual(files, ["src/café.ts", "src/my file.ts", "src/new/ünt racked.ts", "src/plain.ts"]);
});

test("unreadable files and commented env() urls don't break the scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-perm-"));
  mkdirSync(join(dir, "prisma"));
  writeFileSync(join(dir, "prisma/schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL") // pooled\n}\n');
  assert.equal(scanRepo(dir).schemas[0].url, 'env("DATABASE_URL")');
});
