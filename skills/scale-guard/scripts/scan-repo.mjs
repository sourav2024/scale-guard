#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { parseArgs } from "node:util";

const HELP = `scan-repo — read-only static scan for performance and scalability leads

Usage:
  node scan-repo.mjs <repo-path> [--limit 15] [--json]

Reports leads, not findings. Verify every item in code before reporting it.
Never prints file contents beyond one trimmed line per hit, and never reads .env values.
`;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "vendor", ".expo", "android", "ios", "migrations"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const MAX_FILE_BYTES = 1_500_000;
const ORM_OPS = "findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy|query|execute|\\$queryRaw|\\$executeRaw";
const QUERY_CALL = new RegExp(`\\bawait\\s+(?:[\\w$]+\\.[\\w$]+\\.(?:${ORM_OPS})|[\\w$]+\\.\\$(?:queryRaw|executeRaw)\\w*)\\s*[(\`]`);
const EXTERNAL_IO = /\b(fetch|axios(?:\.\w+)?|got(?:\.\w+)?|ky(?:\.\w+)?|undici\.request|https?\.request|sendMail|\w*[Cc]lient\.send)\s*\(/;
const CLIENT_DIR = /(^|\/)(apps\/(web|mobile|app|frontend|client)|packages\/(ui|web)|src\/(components|pages|hooks|screens|views))(\/|$)/;

function walk(root, onFile) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(p);
      } else if (e.isFile()) {
        onFile(p);
      }
    }
  }
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, idx) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function isCommentAt(src, idx) {
  const ls = src.lastIndexOf("\n", idx - 1) + 1;
  const head = src.slice(ls, idx).trimStart();
  return head.startsWith("//") || head.startsWith("*") || head.startsWith("/*");
}

const PATH_RANK = [
  [/(^|\/)(scripts|tools|seed|seeds|fixtures|backfill|e2e|__mocks__)(\/|$)|seed|backfill|Backfill/i, 3],
  [/(^|\/)(queue|queues|workers?|cron|jobs?)(\/|$)|Worker\.|Queue\./, 1],
  [/(^|\/)(controllers?|routes?|api|handlers?|services?|resolvers?)(\/|$)|Controller|Service|Router/, 0],
];

export function pathRank(file) {
  for (const [re, r] of PATH_RANK) if (re.test(file)) return r;
  return 2;
}

export function matchClose(src, openIdx) {
  const open = src[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function snippet(src, starts, line) {
  const s = starts[line - 1];
  const e = src.indexOf("\n", s);
  return src.slice(s, e === -1 ? undefined : e).trim().slice(0, 140);
}

export function scanSource(src, file) {
  const starts = lineStarts(src);
  const hits = [];
  const add = (kind, idx, extra = {}) => {
    const line = lineAt(starts, idx);
    hits.push({ kind, file, line, code: snippet(src, starts, line), ...extra });
  };

  for (const m of src.matchAll(/new\s+PrismaClient\s*\(/g)) add("prisma-client", m.index);

  for (const m of src.matchAll(/\b(connection_limit|pool_timeout|connectionLimit|poolSize|pool_size|maxPoolSize)\b|\bmax\s*:\s*\d+/g)) {
    if (/\bmax\s*:/.test(m[0]) && !/Pool|pool|knex|sequelize|createPool/.test(src)) continue;
    if (isCommentAt(src, m.index)) continue;
    add("pool-setting", m.index, { setting: m[0] });
  }

  for (const m of src.matchAll(/\.\$transaction\s*\(\s*async\b/g)) {
    const open = src.indexOf("(", m.index + 1);
    const end = matchClose(src, open);
    const body = end === -1 ? "" : src.slice(open, end);
    const queries = (body.match(new RegExp(`\\.(?:${ORM_OPS})\\s*\\(`, "g")) || []).length;
    const io = EXTERNAL_IO.exec(body);
    const timeout = /\b(timeout|maxWait)\s*:\s*([\d_]+)\s*,?\s*\}?\s*$/.exec(body.slice(-160));
    add(io ? "transaction-external-io" : "interactive-transaction", m.index, {
      queries,
      externalIo: io ? io[1] : undefined,
      timeout: timeout ? `${timeout[1]}=${timeout[2]}` : undefined,
    });
  }

  const loopRe = /\b(for\s*(?:await\s*)?\(|while\s*\()|\.(forEach|map|flatMap|reduce)\s*\(\s*(?:async\b)?/g;
  for (const m of src.matchAll(loopRe)) {
    let bodyStart;
    let bodyEnd;
    if (m[1]) {
      const headOpen = src.indexOf("(", m.index);
      const headClose = matchClose(src, headOpen);
      if (headClose === -1) continue;
      let j = headClose + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== "{") continue;
      bodyStart = j;
      bodyEnd = matchClose(src, j);
    } else {
      if (!/async\s*$/.test(m[0]) && !/async/.test(src.slice(m.index, m.index + m[0].length + 30))) continue;
      const open = src.indexOf("(", m.index);
      bodyStart = open;
      bodyEnd = matchClose(src, open);
    }
    if (bodyEnd === -1) continue;
    const body = src.slice(bodyStart, bodyEnd);
    const q = QUERY_CALL.exec(body);
    if (!q) continue;
    const inPromiseAll = !m[1] && /Promise\.(all|allSettled)\s*\(\s*[\w$.]*$/.test(src.slice(Math.max(0, m.index - 120), m.index));
    add(m[1] ? "query-in-loop" : "query-in-callback", bodyStart + q.index, { loop: (m[1] || m[2]).replace(/\s|\(/g, ""), parallel: inPromiseAll || undefined });
  }

  for (const m of src.matchAll(/\.findMany\s*\(/g)) {
    const open = src.indexOf("(", m.index);
    const end = matchClose(src, open);
    if (end === -1) continue;
    const args = src.slice(open + 1, end);
    if (/\btake\s*:/.test(args) || /\.\.\.\s*\w*(paginat|page|limit|take)/i.test(args)) continue;
    if (/^\s*\w+\s*$/.test(args)) continue;
    add("unbounded-findMany", m.index);
  }

  for (const m of src.matchAll(/new\s+Worker\s*(?:<[^>()]*>)?\s*\(/g)) {
    const open = src.indexOf("(", m.index);
    const end = matchClose(src, open);
    const args = end === -1 ? "" : src.slice(open, end);
    const c = /concurrency\s*:\s*([\w.]+)/.exec(args);
    const n = c && /^\d+$/.test(c[1]) ? Number(c[1]) : undefined;
    const usesDb = new RegExp(`\\.(?:${ORM_OPS})\\s*[(\`]`).test(args);
    add("queue-worker", m.index, { concurrency: n ?? (c ? c[1] : 1), usesDb });
  }

  for (const m of src.matchAll(/\b(?:app|server|router)\.use\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    add("global-middleware", m.index, { middleware: m[1] });
  }

  for (const m of src.matchAll(/\b(cron\.schedule|new\s+CronJob|schedule\.scheduleJob|repeat\s*:\s*\{)/g)) add("scheduled-job", m.index);

  if (CLIENT_DIR.test(file) || /\.(tsx|jsx)$/.test(file)) {
    for (const m of src.matchAll(/\b(refetchInterval|pollingInterval)\s*:\s*([^,}\n]+)|\bsetInterval\s*\(/g)) {
      add("client-polling", m.index, { interval: m[2]?.trim() });
    }
  }

  for (const m of src.matchAll(/\.sort\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    if (/findMany\s*\(/.test(before)) add("in-memory-sort-after-query", m.index);
  }

  return hits;
}

function scanPrismaSchemas(root, files) {
  const out = [];
  for (const f of files) {
    if (basename(f) !== "schema.prisma") continue;
    const src = readFileSync(f, "utf8");
    const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/s.exec(src)?.[1];
    const url = /datasource\s+\w+\s*\{[^}]*url\s*=\s*([^\n]+)/s.exec(src)?.[1]?.trim();
    const preview = /previewFeatures\s*=\s*\[([^\]]*)\]/.exec(src)?.[1]?.replace(/["\s]/g, "").split(",").filter(Boolean) || [];
    out.push({ file: relative(root, f), provider, url, previewFeatures: preview, relationJoins: preview.includes("relationJoins"), metrics: preview.includes("metrics") });
  }
  return out;
}

function scanPrismaVersions(root, files) {
  const out = [];
  for (const f of files) {
    if (basename(f) !== "package.json") continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const v = deps["@prisma/client"] ?? deps.prisma;
    if (v) out.push({ file: relative(root, f), version: v, adapters: Object.keys(deps).filter((d) => d.startsWith("@prisma/adapter-")) });
  }
  return out;
}

function scanEnvKeys(root, files) {
  const out = [];
  for (const f of files) {
    const b = basename(f);
    if (!/^\.env(\..+)?$/.test(b) && b !== ".env.example") continue;
    const src = readFileSync(f, "utf8");
    for (const line of src.split("\n")) {
      const m = /^\s*([A-Z0-9_]*(DATABASE|DB|POSTGRES|MYSQL|PG)[A-Z0-9_]*URL)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[3];
      out.push({
        file: relative(root, f),
        key: m[1],
        hasConnectionLimit: /connection_limit=/.test(v),
        hasPoolTimeout: /pool_timeout=/.test(v),
        hasPgbouncer: /pgbouncer=true/.test(v),
      });
    }
  }
  return out;
}

export function scanRepo(root) {
  const files = [];
  walk(root, (p) => files.push(p));
  const envFiles = files.filter((p) => /^\.env/.test(basename(p)));
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (!CODE_EXT.has(extname(f))) continue;
    if (/\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(f) || /\/(__tests__|test|tests|e2e)\//.test(f) || /\.d\.ts$/.test(f)) continue;
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    const src = readFileSync(f, "utf8");
    scanned++;
    hits.push(...scanSource(src, relative(root, f)));
  }
  hits.sort((a, b) => pathRank(a.file) - pathRank(b.file) || a.file.localeCompare(b.file) || a.line - b.line);
  const schemas = scanPrismaSchemas(root, files);
  const prismaVersions = scanPrismaVersions(root, files);
  const env = scanEnvKeys(root, envFiles);
  return { root, scanned, schemas, prismaVersions, env, hits };
}

const SECTIONS = [
  ["prisma-client", "PrismaClient instantiations", "Each one is a separate pool. More than one per process multiplies connections."],
  ["pool-setting", "Explicit pool settings in code", "If none exist for a client, it runs on the driver/ORM default."],
  ["queue-worker", "Queue workers (in-process concurrency)", "If these run in the API process they share its pool. Sum their concurrency into the connection budget."],
  ["global-middleware", "Global middleware", "Runs on every request. If it queries the database, every route queues for a connection, including trivial ones."],
  ["scheduled-job", "Scheduled jobs", "Crons in the API process also share its pool."],
  ["transaction-external-io", "Interactive transactions with external I/O inside", "Holds a connection across network calls. High pool-starvation risk."],
  ["interactive-transaction", "Interactive transactions", "Each holds one connection for the whole callback."],
  ["query-in-loop", "Queries inside loops (possible N+1)", "Check cardinality: how many iterations per request?"],
  ["query-in-callback", "Queries inside async map/forEach callbacks", "N+1 or unbounded parallel fan-out against the pool."],
  ["unbounded-findMany", "findMany without take", "Check whether the table is tenant-scaled. Many are fine (small lookup tables)."],
  ["in-memory-sort-after-query", "In-memory sort shortly after a findMany", "Possible full read + JS sort on the request path."],
  ["client-polling", "Client polling / intervals", "Per-row or per-card polling multiplies server load by visible items × viewers."],
];

function renderMarkdown(r, limit) {
  const out = [];
  out.push(`# ScaleGuard static scan`);
  out.push(``);
  out.push(`Scanned ${r.scanned} source files under \`${r.root}\`. These are **leads**; verify each in code.`);
  out.push(``);
  out.push(`## Prisma schemas`);
  if (!r.schemas.length) out.push(`None found.`);
  for (const s of r.schemas) {
    out.push(`- \`${s.file}\`: provider=${s.provider ?? "?"}, url=${s.url ?? "?"}, relationJoins=${s.relationJoins}, metrics=${s.metrics}`);
  }
  out.push(``);
  out.push(`## Prisma versions`);
  if (!r.prismaVersions.length) out.push(`Not found. Pool defaults depend on the major version (≤6: built-in pool, physical_cpus*2+1; 7 / driver adapters: the driver's pool). State the assumption.`);
  for (const v of r.prismaVersions) out.push(`- \`${v.file}\`: ${v.version}${v.adapters.length ? `, adapters: ${v.adapters.join(", ")}` : ""}`);
  out.push(``);
  out.push(`## Database URLs in env files (values not shown)`);
  if (!r.env.length) out.push(`None found. Production env is usually outside the repo: treat pool size as unknown/inferred.`);
  for (const e of r.env) {
    out.push(`- \`${e.file}\` ${e.key}: connection_limit=${e.hasConnectionLimit ? "set" : "ABSENT"}, pool_timeout=${e.hasPoolTimeout ? "set" : "absent"}${e.hasPgbouncer ? ", pgbouncer=true" : ""}`);
  }
  out.push(``);
  const workers = r.hits.filter((h) => h.kind === "queue-worker");
  const numeric = workers.filter((w) => typeof w.concurrency === "number");
  if (workers.length) {
    const dbNumeric = numeric.filter((w) => w.usesDb);
    out.push(`Queue workers: ${workers.length}; summed numeric concurrency: ${numeric.reduce((s, w) => s + w.concurrency, 0)}, of which visibly DB-using: ${dbNumeric.reduce((s, w) => s + w.concurrency, 0)}${numeric.length < workers.length ? ` (+${workers.length - numeric.length} with non-literal concurrency)` : ""}. Processors defined in other files show as not DB-using; check them.`);
    out.push(``);
  }
  for (const [kind, title, note] of SECTIONS) {
    const list = r.hits.filter((h) => h.kind === kind);
    if (!list.length) continue;
    out.push(`## ${title} (${list.length})`);
    out.push(`_${note}_`);
    out.push(``);
    for (const h of list.slice(0, limit)) {
      const extra = [];
      if (h.queries !== undefined) extra.push(`${h.queries} queries`);
      if (h.externalIo) extra.push(`external I/O: ${h.externalIo}`);
      if (h.timeout) extra.push(h.timeout);
      if (h.concurrency !== undefined) extra.push(`concurrency ${h.concurrency}`);
      if (h.usesDb !== undefined) extra.push(h.usesDb ? "uses DB" : "no DB call seen inline");
      if (h.middleware) extra.push(h.middleware);
      if (h.loop) extra.push(`loop: ${h.loop}`);
      if (h.parallel) extra.push(`inside Promise.all`);
      if (h.interval) extra.push(`interval ${h.interval}`);
      if (h.setting) extra.push(h.setting);
      out.push(`- \`${h.file}:${h.line}\`${extra.length ? ` (${extra.join(", ")})` : ""} — \`${h.code}\``);
    }
    if (list.length > limit) out.push(`- … ${list.length - limit} more (use --limit or --json)`);
    out.push(``);
  }
  return out.join("\n");
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { limit: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || !positionals[0]) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const r = scanRepo(positionals[0]);
  const limit = Number(values.limit ?? 15);
  process.stdout.write((values.json ? JSON.stringify(r, null, 2) : renderMarkdown(r, limit)) + "\n");
  return 0;
}

if (process.argv[1]?.endsWith("scan-repo.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`scan-repo: ${e.message}\n`);
    process.exitCode = 2;
  }
}
