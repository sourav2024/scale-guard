#!/usr/bin/env node
import { parseArgs } from "node:util";

const HELP = `conn-budget — database connection budget and pool sizing

Usage:
  node conn-budget.mjs --tier <spec> [--tier <spec> ...] [options]

Tier spec (comma-separated key=value):
  name=<label>        process type, e.g. api, worker, cron
  replicas=<n>        hosts / containers running this process type (default 1)
  procs=<n>           processes per replica, e.g. pm2 instances (default 1)
  pool=<n>            pool max per process; omit to derive Prisma's default
  physical=<n>        physical CPU cores per replica (for the Prisma default)
  vcpus=<n>           vCPUs per replica; physical assumed vcpus/2 if physical omitted
  clients=<n>         separate pools per process, e.g. two PrismaClients (default 1)
  workers=<n>         combined concurrency of in-process jobs sharing the pool
  qps=<n>             queries per second per process (for Little's law)
  hold=<ms>           average connection hold time per query in ms

Options:
  --max-connections <n>  server limit (max_connections)
  --reserved <n>         connections used by admin/BI/migrations/other services (default 0)
  --headroom <pct>       headroom to keep free, percent (default 25)
  --burst <x>            burst multiplier applied to Little's-law demand (default 3)
  --json                 machine-readable output
  -h, --help

Example:
  node conn-budget.mjs --tier name=api,replicas=3,vcpus=4,workers=70,qps=150,hold=6 \\
    --max-connections 90 --reserved 10
`;

function parseTier(spec) {
  const t = { name: "tier", replicas: 1, procs: 1, clients: 1, workers: 0 };
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k) continue;
    if (k === "name") t.name = v;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number for ${k} in "${spec}"`);
      t[k] = n;
    }
  }
  return t;
}

function prismaDefault(t) {
  const physical = t.physical ?? (t.vcpus ? Math.max(1, Math.floor(t.vcpus / 2)) : undefined);
  if (physical === undefined) return undefined;
  return physical * 2 + 1;
}

export function computeBudget({ tiers, maxConnections, reserved = 0, headroom = 25, burst = 3 }) {
  const rows = tiers.map((t) => {
    let pool = t.pool;
    let poolSource = "explicit";
    if (pool === undefined) {
      pool = prismaDefault(t);
      poolSource = pool === undefined ? "unknown" : "prisma-default";
    }
    const processes = t.replicas * t.procs;
    const total = pool === undefined ? undefined : processes * pool * t.clients;
    let demand;
    if (t.qps !== undefined && t.hold !== undefined) {
      const avg = (t.qps * t.hold) / 1000;
      demand = { average: avg, burst: avg * burst };
    }
    const warnings = [];
    if (pool !== undefined && t.workers > 0 && t.workers >= pool) {
      warnings.push(`in-process job concurrency (${t.workers}) >= pool (${pool}): jobs alone can exhaust the pool`);
    }
    if (pool !== undefined && demand && demand.burst > pool) {
      warnings.push(`burst demand ${demand.burst.toFixed(1)} > pool ${pool}: expect queueing`);
    }
    if (poolSource === "prisma-default") {
      warnings.push("pool size is Prisma's CPU-derived default (Prisma <= 6 built-in pool); the CPU count Prisma sees inside a container can differ from the VM's, so set connection_limit explicitly");
    }
    return { ...t, pool, poolSource, processes, total, demand, warnings };
  });

  const known = rows.every((r) => r.total !== undefined);
  const appTotal = known ? rows.reduce((s, r) => s + r.total, 0) : undefined;
  const grand = appTotal === undefined ? undefined : appTotal + reserved;
  let verdict = "unknown";
  let usable;
  if (maxConnections !== undefined) {
    usable = Math.floor(maxConnections * (1 - headroom / 100));
    if (grand !== undefined) verdict = grand <= usable ? "fits" : grand <= maxConnections ? "tight" : "over";
  }
  let suggestion;
  if (usable !== undefined) {
    const procCount = rows.reduce((s, r) => s + r.processes * r.clients, 0);
    if (procCount > 0) suggestion = Math.max(1, Math.floor((usable - reserved) / procCount));
  }
  return { rows, appTotal, reserved, grand, maxConnections, usable, headroom, verdict, maxPoolPerProcessUniform: suggestion };
}

function fmt(n, d = 0) {
  return n === undefined ? "?" : Number(n).toFixed(d);
}

function render(r) {
  const out = [];
  out.push("| Tier | Processes | Pool/process | Source | Clients | Total | Avg busy | Burst busy |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const x of r.rows) {
    out.push(`| ${x.name} | ${x.processes} | ${fmt(x.pool)} | ${x.poolSource} | ${x.clients} | ${fmt(x.total)} | ${fmt(x.demand?.average, 1)} | ${fmt(x.demand?.burst, 1)} |`);
  }
  out.push("");
  out.push(`App connections: ${fmt(r.appTotal)}  +  reserved: ${r.reserved}  =  ${fmt(r.grand)}`);
  if (r.maxConnections !== undefined) {
    out.push(`Server max_connections: ${r.maxConnections}  (usable with ${r.headroom}% headroom: ${r.usable})`);
    out.push(`Verdict: ${r.verdict.toUpperCase()}`);
    if (r.maxPoolPerProcessUniform !== undefined) out.push(`Largest uniform pool per process within headroom: ${r.maxPoolPerProcessUniform}`);
  }
  const warns = r.rows.flatMap((x) => x.warnings.map((w) => `- [${x.name}] ${w}`));
  if (warns.length) {
    out.push("");
    out.push("Warnings:");
    out.push(...warns);
  }
  out.push("");
  out.push("Note: estimates only. Confirm with pool metrics and database connection counts.");
  return out.join("\n");
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tier: { type: "string", multiple: true },
      "max-connections": { type: "string" },
      reserved: { type: "string" },
      headroom: { type: "string" },
      burst: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.tier?.length) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const num = (v) => (v === undefined ? undefined : Number(v));
  const result = computeBudget({
    tiers: values.tier.map(parseTier),
    maxConnections: num(values["max-connections"]),
    reserved: num(values.reserved) ?? 0,
    headroom: num(values.headroom) ?? 25,
    burst: num(values.burst) ?? 3,
  });
  process.stdout.write((values.json ? JSON.stringify(result, null, 2) : render(result)) + "\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("conn-budget.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`conn-budget: ${e.message}\n`);
    process.exitCode = 2;
  }
}
