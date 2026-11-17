#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
  --from-scan <file>     JSON from \`scan-repo --json\`: fills workers= and clients= on one tier
                         when you did not set them (and reports pm2/replica hints)
  --scan-tier <name>     tier that receives the scan values (default: the first tier)
  --json                 machine-readable output
  -h, --help

Example:
  node conn-budget.mjs --tier name=api,replicas=3,vcpus=4,workers=70,qps=150,hold=6 \\
    --max-connections 90 --reserved 10
`;

const TIER_KEYS = ["name", "replicas", "procs", "pool", "physical", "vcpus", "clients", "workers", "qps", "hold"];
const INTEGER_KEYS = new Set(["replicas", "procs", "pool", "physical", "vcpus", "clients", "workers"]);
const TIER_DEFAULTS = { name: "tier", replicas: 1, procs: 1, clients: 1, workers: 0 };

export function parseTier(spec) {
  const t = {};
  for (const part of spec.split(",")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    const k = (eq === -1 ? part : part.slice(0, eq)).trim();
    const v = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (!TIER_KEYS.includes(k)) {
      const near = TIER_KEYS.find((x) => x.startsWith(k.slice(0, 3)));
      throw new Error(`unknown tier key "${k}" in "${spec}"${near ? ` (did you mean "${near}"?)` : ""}. Valid keys: ${TIER_KEYS.join(", ")}`);
    }
    if (k in t) throw new Error(`duplicate tier key "${k}" in "${spec}"`);
    if (k === "name") {
      if (!v) throw new Error(`empty name in "${spec}"`);
      t.name = v;
      continue;
    }
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < 0) throw new Error(`invalid number for ${k} in "${spec}": "${v}"`);
    if (INTEGER_KEYS.has(k) && !Number.isInteger(n)) throw new Error(`${k} must be a whole number in "${spec}": "${v}"`);
    t[k] = n;
  }
  return t;
}

/** Derive tier values from scan-repo --json output. */
export function fromScan(scan) {
  const hits = scan.hits ?? [];
  const workers = hits.filter((h) => h.kind === "queue-worker");
  const dbWorkers = workers.filter((w) => w.usesDb !== false);
  const numeric = dbWorkers.filter((w) => typeof w.concurrency === "number");
  const clientsByDeployable = new Map();
  for (const h of hits) {
    if (h.kind !== "prisma-client" || /(^|\/)(scripts|seeds?|tools)\//.test(h.file)) continue;
    const d = h.deployable ?? "(root)";
    clientsByDeployable.set(d, (clientsByDeployable.get(d) ?? 0) + 1);
  }
  const clients = clientsByDeployable.size ? Math.max(...clientsByDeployable.values()) : undefined;
  const hints = hits.filter((h) => h.kind === "process-model").map((h) => `${h.detail} (${h.file}:${h.line})`);
  const notes = [];
  if (workers.length) {
    notes.push(`workers=${numeric.reduce((s, w) => s + w.concurrency, 0)} from ${numeric.length} queue worker(s) that use or may use the DB` +
      (workers.length - dbWorkers.length ? `; ${workers.length - dbWorkers.length} with no DB call excluded` : "") +
      (dbWorkers.length - numeric.length ? `; ${dbWorkers.length - numeric.length} with non-literal concurrency NOT counted` : ""));
  }
  if (clients !== undefined) notes.push(`clients=${clients} (most PrismaClient instances in one deployable)`);
  return {
    values: { workers: workers.length ? numeric.reduce((s, w) => s + w.concurrency, 0) : undefined, clients },
    notes,
    hints,
  };
}

function prismaDefault(t) {
  const physical = t.physical ?? (t.vcpus ? Math.max(1, Math.floor(t.vcpus / 2)) : undefined);
  if (physical === undefined) return undefined;
  return physical * 2 + 1;
}

export function computeBudget({ tiers, maxConnections, reserved = 0, headroom = 25, burst = 3 }) {
  const rows = tiers.map((given) => {
    const t = { ...TIER_DEFAULTS, ...given };
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
  if (r.scan) {
    out.push("");
    out.push(`From scan (applied to tier "${r.scan.tier}" where not set explicitly):`);
    out.push(...(r.scan.notes.length ? r.scan.notes : ["nothing to apply"]).map((n) => `- ${n}`));
    if (r.scan.hints.length) {
      out.push("Process-model hints (set replicas=/procs= yourself):");
      out.push(...r.scan.hints.slice(0, 10).map((h) => `- ${h}`));
    }
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
      "from-scan": { type: "string" },
      "scan-tier": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.tier?.length) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  const num = (name, { int = false, max } = {}) => {
    const v = values[name];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n)) || (max !== undefined && n > max)) {
      throw new Error(`--${name} must be a ${int ? "whole " : ""}number${max !== undefined ? ` from 0 to ${max}` : " >= 0"}, got "${v}"`);
    }
    return n;
  };
  const tiers = values.tier.map(parseTier);
  let scan;
  if (values["from-scan"]) {
    let json;
    try {
      json = JSON.parse(readFileSync(values["from-scan"] === "-" ? 0 : values["from-scan"], "utf8"));
    } catch (e) {
      throw new Error(`--from-scan: cannot read scan JSON (${e.message})`);
    }
    const tierName = values["scan-tier"] ?? tiers[0].name ?? TIER_DEFAULTS.name;
    const target = tiers.find((t) => (t.name ?? TIER_DEFAULTS.name) === tierName);
    if (!target) throw new Error(`--scan-tier "${tierName}" matches no --tier name`);
    const derived = fromScan(json);
    const applied = [];
    for (const [k, v] of Object.entries(derived.values)) {
      if (v === undefined) continue;
      if (k in target) applied.push(`${k} kept at ${target[k]} (set explicitly; scan suggests ${v})`);
      else target[k] = v;
    }
    scan = { tier: tierName, notes: [...derived.notes, ...applied], hints: derived.hints };
  }
  const result = computeBudget({
    tiers,
    maxConnections: num("max-connections", { int: true }),
    reserved: num("reserved", { int: true }) ?? 0,
    headroom: num("headroom", { max: 99 }) ?? 25,
    burst: num("burst") ?? 3,
  });
  if (scan) result.scan = scan;
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
