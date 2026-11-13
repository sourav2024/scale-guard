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
