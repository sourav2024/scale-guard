import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanRepo, scanSource, matchClose, pathRank } from "../skills/scale-guard/scripts/scan-repo.mjs";

const fixture = fileURLToPath(new URL("../evaluations/fixtures/pool-queue-app", import.meta.url));
const kinds = (hits) => hits.map((h) => h.kind);

test("fixture: every planted issue is reported", () => {
  const r = scanRepo(fixture);
  const by = (k) => r.hits.filter((h) => h.kind === k);
  assert.equal(by("prisma-client").length, 1);
  assert.deepEqual(by("queue-worker").map((w) => w.concurrency), [10, 10, 5]);
  assert.equal(by("transaction-external-io").length, 1);
  assert.equal(by("transaction-external-io")[0].timeout, "timeout=30000");
  assert.equal(by("query-in-loop").length, 1);
  assert.equal(by("in-memory-sort-after-query").length, 1);
  assert.equal(by("client-polling").length, 1);
  assert.equal(r.schemas[0].provider, "mysql");
  assert.equal(r.env[0].hasConnectionLimit, false);
});

test("env scan never returns values", () => {
  const r = scanRepo(fixture);
  assert.ok(!JSON.stringify(r.env).includes("mysql://"));
});

test("non-ORM single-dot calls are not N+1", () => {
  const src = "async function f(xs){ for (const x of xs) { const d = await PDFDocument.create(); } }";
  assert.deepEqual(kinds(scanSource(src, "a.ts")), []);
});

test("raw queries in loops are flagged", () => {
  const src = "async function f(xs){ for (const x of xs) { await db.$queryRaw`select 1`; } }";
  assert.deepEqual(kinds(scanSource(src, "a.ts")), ["query-in-loop"]);
});

test("findMany with take is bounded", () => {
  const src = "await prisma.a.findMany({ where: {}, take: 10 });";
  assert.deepEqual(kinds(scanSource(src, "a.ts")), []);
});

test("pool settings in comments are ignored", () => {
  const src = "// set connection_limit here\nconst u = url + '?connection_limit=10';";
  const hits = scanSource(src, "a.ts").filter((h) => h.kind === "pool-setting");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test("matchClose skips strings and comments", () => {
  const src = "f(a, ')', /* ) */ b) // )";
  assert.equal(matchClose(src, 1), src.indexOf("b)") + 1);
});

test("request-path files rank before scripts", () => {
  assert.ok(pathRank("apps/api/src/controllers/x.ts") < pathRank("scripts/seed.ts"));
  assert.ok(pathRank("src/queue/w.ts") < pathRank("src/misc/w.ts"));
});

test("fixture: workers marked by DB use, global middleware and prisma version found", () => {
  const r = scanRepo(fixture);
  assert.deepEqual(r.hits.filter((h) => h.kind === "queue-worker").map((w) => w.usesDb), [true, true, false]);
  assert.deepEqual(r.hits.filter((h) => h.kind === "global-middleware").map((h) => h.middleware), ["auth"]);
  assert.equal(r.prismaVersions[0].version, "6.19.0");
});
