import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBudget } from "../skills/scale-guard/scripts/conn-budget.mjs";

test("Prisma default pool is physical*2+1, physical defaults to vcpus/2", () => {
  const r = computeBudget({ tiers: [{ name: "api", replicas: 3, procs: 1, clients: 1, workers: 0, vcpus: 4 }] });
  assert.equal(r.rows[0].pool, 5);
  assert.equal(r.rows[0].poolSource, "prisma-default");
  assert.equal(r.appTotal, 15);
});

test("workers >= pool warns", () => {
  const r = computeBudget({ tiers: [{ name: "api", replicas: 1, procs: 1, clients: 1, workers: 25, pool: 10 }] });
  assert.match(r.rows[0].warnings.join(), /jobs alone can exhaust/);
});

test("Little's law demand and burst warning", () => {
  const r = computeBudget({ tiers: [{ name: "api", replicas: 1, procs: 1, clients: 1, workers: 0, pool: 5, qps: 1000, hold: 4 }], burst: 3 });
  assert.equal(r.rows[0].demand.average, 4);
  assert.equal(r.rows[0].demand.burst, 12);
  assert.match(r.rows[0].warnings.join(), /expect queueing/);
});

test("verdict and uniform pool suggestion", () => {
  const r = computeBudget({
    tiers: [{ name: "api", replicas: 3, procs: 1, clients: 1, workers: 0, pool: 30 }],
    maxConnections: 90, reserved: 10, headroom: 25,
  });
  assert.equal(r.grand, 100);
  assert.equal(r.verdict, "over");
  assert.equal(r.usable, 67);
  assert.equal(r.maxPoolPerProcessUniform, 19);
});

test("unknown pool yields unknown total", () => {
  const r = computeBudget({ tiers: [{ name: "x", replicas: 1, procs: 1, clients: 1, workers: 0 }], maxConnections: 100 });
  assert.equal(r.appTotal, undefined);
  assert.equal(r.verdict, "unknown");
});

import { parseTier, fromScan } from "../skills/scale-guard/scripts/conn-budget.mjs";

test("unknown or malformed tier keys are rejected", () => {
  assert.throws(() => parseTier("name=api,replica=3"), /unknown tier key "replica".*did you mean "replicas"/);
  assert.throws(() => parseTier("pool=abc"), /invalid number/);
  assert.throws(() => parseTier("replicas=2.5"), /whole number/);
  assert.throws(() => parseTier("pool=5,pool=6"), /duplicate/);
  assert.deepEqual(parseTier("name=api,replicas=3"), { name: "api", replicas: 3 });
});

test("tiers without explicit counts get defaults", () => {
  const r = computeBudget({ tiers: [{ name: "api", pool: 10 }] });
  assert.equal(r.appTotal, 10);
});

test("fromScan sums DB-using worker concurrency and counts clients per deployable", () => {
  const d = fromScan({
    hits: [
      { kind: "queue-worker", concurrency: 10, usesDb: true },
      { kind: "queue-worker", concurrency: 5, usesDb: "likely" },
      { kind: "queue-worker", concurrency: 7, usesDb: false },
      { kind: "queue-worker", concurrency: "env.N", usesDb: "unknown" },
      { kind: "prisma-client", file: "apps/api/a.ts", deployable: "apps/api" },
      { kind: "prisma-client", file: "apps/api/b.ts", deployable: "apps/api" },
      { kind: "prisma-client", file: "scripts/x.ts", deployable: "scripts" },
      { kind: "process-model", detail: "pm2 instances=4", file: "ecosystem.config.js", line: 2 },
    ],
  });
  assert.equal(d.values.workers, 15);
  assert.equal(d.values.clients, 2);
  assert.match(d.notes[0], /non-literal concurrency NOT counted/);
  assert.equal(d.hints.length, 1);
});
