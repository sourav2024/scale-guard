#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const HELP = `scan-repo — read-only static scan for performance and scalability leads

Usage:
  node scan-repo.mjs <repo-path> [options]

Options:
  --limit <n>             leads shown per section (default 15)
  --json                  machine-readable output (feed it to conn-budget --from-scan)
  --include <glob>        only scan matching paths (repeatable or comma-separated)
  --exclude <glob>        skip matching paths (repeatable or comma-separated)
  --hot-models <a,b>      Prisma models you know grow fast; ranked first among findMany leads
  --include-env           also open real .env files (see below)
  --changed-since <ref>   only leads on lines added or changed since the merge-base with <ref>
                          (includes uncommitted and untracked files); for PR checks
  --fail-on <level>       exit 1 if any reported lead is at or above high|medium|low
  -h, --help

Reports leads, not findings. Verify every item in code before reporting it.

Secrets: prints at most one trimmed code line per lead. By default it reads only
.env.example / .env.sample / .env.template. With --include-env it also opens real
.env files to check which pool flags are present in database URLs; values are never
printed. Literal (non-env()) database URLs in schema.prisma are redacted.

Silence a reviewed lead with a comment on the same or the previous line:
  // scale-guard-ignore: <reason>

Exit codes: 0 ok, 1 --fail-on threshold met, 2 error.
`;

// ---------------------------------------------------------------------------
// File selection

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "vendor",
  ".expo", "android", "ios", "migrations", "playwright-report", "test-results", "storybook-static",
  "public", "generated", "__generated__",
]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const MAX_FILE_BYTES = 1_500_000;
function hasLongLine(src, max = 1000) {
  let start = 0;
  for (;;) {
    const nl = src.indexOf("\n", start);
    if ((nl === -1 ? src.length : nl) - start > max) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}
const TEST_FILE = /\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\.[cm]?js$|(^|\/)(__tests__|__mocks__|test|tests|e2e|cypress)\//;
const EXAMPLE_ENV = /^\.env\.(example|sample|template|dist|defaults)$/;
const REAL_ENV = /^\.env(\..+)?$/;

const toPosix = (p) => p.split(sep).join("/");

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

export function globToRegExp(glob) {
  const g = glob.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!/[*?]/.test(g)) return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&")}(/|$)`);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const splitList = (vals) => (vals ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Source helpers

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

function lineText(src, starts, line) {
  if (line < 1 || line > starts.length) return "";
  const s = starts[line - 1];
  const e = src.indexOf("\n", s);
  return src.slice(s, e === -1 ? undefined : e);
}

function isCommentAt(src, idx, hash = false) {
  const ls = src.lastIndexOf("\n", idx - 1) + 1;
  const head = src.slice(ls, idx).trimStart();
  if (hash) return head.startsWith("#");
  return head.startsWith("//") || head.startsWith("*") || head.startsWith("/*");
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

/** Top-level comma-separated arguments between src[open] === "(" and src[close] === ")". */
function splitArgs(src, open, close) {
  const parts = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < close && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < close && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e === -1 ? close : e + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start, close));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function callArgs(src, idx) {
  const open = src.indexOf("(", idx);
  if (open === -1) return undefined;
  const close = matchClose(src, open);
  if (close === -1) return undefined;
  return { open, close, text: src.slice(open + 1, close), args: splitArgs(src, open, close) };
}

/** Strip credentials from a code line before it is printed. */
export function redact(line) {
  return line
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@'"`]*@/gi, "$1***@")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[=:]\s*["'`]?)(?!process\.env|env\(|\$\{)[^\s"'`&,;)}]+/gi, "$1$2***");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// ---------------------------------------------------------------------------
// What counts as a database call

const ORM_OPS = "findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy|query|execute";
const RAW_RECEIVER = "[\\w$]*(?:[Pp]ool|[Cc]onn|[Cc]onnection|[Cc]lient|[Dd][Bb]|knex|pg|mysql|sql|[Tt]rx|tx)";
// a.b.op(  this.prisma.user.op(  pool.query(  conn.execute(  db.$queryRaw`
const DB_CALL_SRC = `(?<![\\w$.])(?:(?:[\\w$]+\\.){2,}(?:${ORM_OPS})|${RAW_RECEIVER}\\.(?:query|execute)|(?:[\\w$]+\\.)+\\$(?:queryRaw|executeRaw)\\w*)\\s*[(\`]`;
const DB_CALL = new RegExp(DB_CALL_SRC);
const DB_CALL_G = () => new RegExp(DB_CALL_SRC, "g");
const EXTERNAL_IO = /\b(fetch|axios(?:\.\w+)?|got(?:\.\w+)?|ky(?:\.\w+)?|undici\.request|https?\.request|sendMail|\w*[Cc]lient\.send)\s*\(/;
const CLIENT_DIR = /(^|\/)(apps\/(web|mobile|app|frontend|client|admin|portal)|packages\/(ui|web)|src\/(components|pages|hooks|screens|views|features))(\/|$)/;
const PER_ROW_FILE = /(Row|Item|Cell|Card|Tile|Entry)\.[cm]?[jt]sx?$/;
const FETCHY_BODY = /\b(fetch|axios|ky|dispatch|refetch\w*|invalidate\w*|mutate\w*|trigger\w*|request)\s*\(|\.(get|post|put|patch|query|fetch\w*|refetch\w*|load\w*|emit)\s*\(/;
const FETCHY_NAME = /fetch|refresh|reload|load|poll|sync|update|check/i;
const REQ_INPUT = /\b(?:req|request|ctx(?:\.request)?|event)\.(?:query|body)\b|\bsearchParams\.get\s*\(/;
const NOT_CALLEES = new Set(["if", "for", "while", "switch", "catch", "function", "return", "await", "typeof", "new", "super", "import", "require", "async", "Promise", "Number", "String", "Boolean", "Object", "Array", "JSON", "Math", "Date", "Error", "console", "setTimeout", "setInterval", "parseInt", "parseFloat"]);

const PATH_RANK = [
  [/(^|\/)(scripts|tools|seed|seeds|fixtures|backfill|e2e|__mocks__)(\/|$)|seed|backfill|Backfill/i, 3],
  [/(^|\/)(queue|queues|workers?|cron|jobs?)(\/|$)|Worker\.|Queue\./, 1],
  [/(^|\/)(controllers?|routes?|api|handlers?|services?|resolvers?)(\/|$)|Controller|Service|Router/, 0],
];

export function pathRank(file) {
  for (const [re, r] of PATH_RANK) if (re.test(file)) return r;
  return 2;
}

export function deployable(file) {
  const parts = file.split("/");
  if (parts.length > 2 && /^(apps|packages|services|libs|modules)$/.test(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : "(root)";
}

// ---------------------------------------------------------------------------
// Import / function resolution (used for queue processors)

/** Local bindings a file imports from module `mod`: { ns: [...], named: Map(local -> imported) }. */
function moduleBindings(src, mod) {
  if (!src.includes(`"${mod}"`) && !src.includes(`'${mod}'`)) return { ns: [], named: new Map(), any: false };
  const m = esc(mod);
  const ns = [];
  const named = new Map();
  const addNamed = (list) => {
    for (const part of list.split(",")) {
      const p = part.replace(/^\s*type\s+/, "").trim();
      if (!p) continue;
      const [imported, local] = p.split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
      named.set(local || imported, imported);
    }
  };
  for (const x of src.matchAll(new RegExp(`import\\s+(?:([\\w$]+)\\s*,?\\s*)?(?:\\*\\s*as\\s+([\\w$]+)\\s*)?(?:\\{([^}]*)\\}\\s*)?from\\s*["']${m}["']`, "g"))) {
    if (x[1] && x[1] !== "type") ns.push(x[1]);
    if (x[2]) ns.push(x[2]);
    if (x[3]) addNamed(x[3]);
  }
  for (const x of src.matchAll(new RegExp(`(?:const|let|var)\\s+(?:([\\w$]+)|\\{([^}]*)\\})\\s*=\\s*require\\(\\s*["']${m}["']\\s*\\)`, "g"))) {
    if (x[1]) ns.push(x[1]);
    if (x[2]) addNamed(x[2]);
  }
  return { ns, named, any: ns.length > 0 || named.size > 0 };
}

function localFor(b, imported) {
  return [...b.named].filter(([, imp]) => imp === imported).map(([local]) => local);
}

function importOf(src, name) {
  const n = esc(name);
  let m = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*?\\b([\\w$]+)\\s+as\\s+${n}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`).exec(src);
  if (m) return { spec: m[2], exported: m[1] };
  m = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*?(?<![\\w$]\\s+as\\s+)\\b${n}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`).exec(src);
  if (m) return { spec: m[1], exported: name };
  m = new RegExp(`import\\s+${n}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*["']([^"']+)["']`).exec(src);
  if (m) return { spec: m[1], exported: "default" };
  m = new RegExp(`(?:const|let|var)\\s*\\{[^}]*?\\b${n}\\b[^}]*\\}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(src);
  if (m) return { spec: m[1], exported: name };
  m = new RegExp(`(?:const|let|var)\\s+${n}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(src);
  if (m) return { spec: m[1], exported: "default" };
  return undefined;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveModule(fromAbs, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromAbs), spec);
  const stripped = base.replace(/\.[cm]?[jt]sx?$/, "");
  const cands = [base, ...RESOLVE_EXTS.map((e) => stripped + e), ...RESOLVE_EXTS.map((e) => join(base, `index${e}`))];
  return cands.find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Function body starting at i (just after a parameter list or arrow-function head). */
function bodyFrom(src, i) {
  const rest = src.slice(i, i + 300);
  const arrow = /^\s*(?::[^=;{]+)?=>\s*/.exec(rest);
  if (arrow) {
    const k = i + arrow[0].length;
    if (src[k] === "{") {
      const e = matchClose(src, k);
      return src.slice(k, e === -1 ? undefined : e + 1);
    }
    const stop = src.slice(k).search(/;\s*\n|\n\s*\n|\n(?=\S)/);
    return src.slice(k, stop === -1 ? undefined : k + stop);
  }
  const brace = /^\s*(?::\s*[^;{=]+?)?\s*\{/.exec(rest);
  if (!brace) return undefined;
  const b = i + brace[0].length - 1;
  const e = matchClose(src, b);
  return src.slice(b, e === -1 ? undefined : e + 1);
}

export function findFunctionBody(src, name) {
  if (name === "default") {
    const m = /export\s+default\s+(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?/.exec(src);
    if (!m) return undefined;
    let i = m.index + m[0].length;
    const ident = /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(src.slice(i, i + 80));
    if (ident && ident[1] !== "async") return findFunctionBody(src, ident[1]);
    if (src[i] === "(") {
      const e = matchClose(src, i);
      if (e === -1) return undefined;
      i = e + 1;
    } else {
      const single = /^[A-Za-z_$][\w$]*(?=\s*=>)/.exec(src.slice(i, i + 80));
      if (single) i += single[0].length;
    }
    return bodyFrom(src, i);
  }
  const n = esc(name);
  const heads = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*(?:<[^>]*>)?\\s*\\(`),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b[^(]*)?\\(`),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s+)?[\\w$]+(?=\\s*=>)`),
    new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|async|override)\\s+)*${n}\\s*\\(`, "m"),
  ];
  for (const re of heads) {
    const m = re.exec(src);
    if (!m) continue;
    let i = m.index + m[0].length;
    if (src[i - 1] === "(") {
      const e = matchClose(src, i - 1);
      if (e === -1) continue;
      i = e + 1;
    }
    const body = bodyFrom(src, i);
    if (body !== undefined) return body;
  }
  return undefined;
}

function calledNames(body) {
  const out = new Set();
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!NOT_CALLEES.has(m[1])) out.add(m[1]);
  return [...out];
}

// Method calls (service.x(), this.repo.y()) cannot be followed statically.
const hasOpaqueCall = (s) => /[\w$)\]]\s*\.\s*(?!then\b|catch\b|finally\b|log\b|push\b|map\b|filter\b|join\b)[\w$]+\s*\(/.test(s);

const STRENGTH = { yes: 3, likely: 2, no: 1, unresolved: 0 };
const stronger = (a, b) => (STRENGTH[b] > STRENGTH[a] ? b : a);

/** Does function `name`, visible in file `abs`, touch the database? yes | likely | no | unresolved */
function analyzeDbUse(abs, name, depth, ctx) {
  const key = `${abs}#${name}`;
  if (ctx.seen.has(key)) return "no";
  ctx.seen.add(key);
  const src = ctx.read(abs);
  if (src === undefined) return "unresolved";
  const body = findFunctionBody(src, name);
  if (body === undefined) {
    const imp = importOf(src, name);
    if (!imp) return "unresolved";
    const target = resolveModule(abs, imp.spec);
    return target ? analyzeDbUse(target, imp.exported, depth, ctx) : "unresolved";
  }
  if (DB_CALL.test(body)) return "yes";
  let best = "no";
  let opaque = hasOpaqueCall(body.slice(1));
  for (const callee of depth > 0 ? calledNames(body) : []) {
    if (callee === name) continue;
    const r = analyzeDbUse(abs, callee, depth - 1, ctx);
    if (r === "unresolved") opaque = true;
    else best = stronger(best, r);
    if (best === "yes") return best;
  }
  if (best === "no" && opaque) return DB_CALL.test(src) ? "likely" : "unresolved";
  return best;
}

// ---------------------------------------------------------------------------
// Per-file scan

const LOOP_KINDS = new Set(["query-in-loop", "query-in-callback"]);

export function scanSource(src, file, opts = {}) {
  const starts = lineStarts(src);
  const hits = [];
  const seen = new Map();
  const ignored = opts.ignored ?? [];

  const add = (kind, idx, extra = {}) => {
    if (isCommentAt(src, idx)) return undefined;
    const line = lineAt(starts, idx);
    const ign = /scale-guard-ignore\b:?\s*(.*)$/.exec(lineText(src, starts, line)) ?? /^\s*(?:\/\/|\/?\*|#).*scale-guard-ignore\b:?\s*(.*)$/.exec(lineText(src, starts, line - 1));
    if (ign) {
      ignored.push({ kind, file, line, reason: ign[1].replace(/\*\/\s*$/, "").trim() || undefined });
      return undefined;
    }
    const key = `${LOOP_KINDS.has(kind) ? "loop" : kind}|${line}`;
    const prev = seen.get(key);
    if (prev) {
      if (LOOP_KINDS.has(kind)) prev.depth = (prev.depth ?? 1) + 1;
      return prev;
    }
    const code = redact(lineText(src, starts, line).trim()).slice(0, 140);
    const hit = { kind, file, line, code, ...extra };
    for (const k of Object.keys(hit)) if (hit[k] === undefined) delete hit[k];
    seen.set(key, hit);
    hits.push(hit);
    return hit;
  };

  // --- Prisma clients, extensions -------------------------------------------
  for (const m of src.matchAll(/new\s+PrismaClient\s*\(/g)) {
    const a = callArgs(src, m.index);
    const t = a?.text ?? "";
    const txo = /transactionOptions\s*:\s*\{([^}]*)\}/.exec(t)?.[1];
    add("prisma-client", m.index, {
      adapter: /\badapter\s*[:,}]/.test(t) || undefined,
      transactionOptions: txo ? txo.replace(/\s+/g, " ").trim() : undefined,
    });
  }
  for (const m of src.matchAll(/\.\$extends\s*\(/g)) {
    const a = callArgs(src, m.index);
    if (!a || !/\bquery\s*:\s*\{/.test(a.text)) continue;
    add("prisma-extension", m.index, {
      scope: /\$allModels|\$allOperations/.test(a.text) ? "all models/operations" : undefined,
      extraQueries: DB_CALL.test(a.text) || /\$transaction|\.create\s*\(/.test(a.text) || undefined,
    });
  }

  // --- Pool settings ---------------------------------------------------------
  for (const m of src.matchAll(/\b(connection_limit|pool_timeout|connectionLimit|poolSize|pool_size|maxPoolSize|connectionPoolSize)\b|\bmax\s*:/g)) {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 160).split("\n")[0];
    if (/^\s*\??\s*:\s*(?:number|string|boolean|null|undefined|any|Number|String)\b/.test(after)) continue;
    if (m[0].startsWith("max")) {
      if (!/^\s*(?:\d|Number\(|parseInt\(|\+\s*process|process\.env|env\.|config\.)/.test(after)) continue;
      if (!/Pool|pool|knex|sequelize|createPool|connection/.test(src.slice(Math.max(0, m.index - 300), m.index))) continue;
    }
    const env = /process\.env\.([A-Z0-9_]+)|process\.env\[["']([A-Z0-9_]+)["']\]|\benv\(\s*["']([A-Z0-9_]+)["']/.exec(after);
    add("pool-setting", m.index, { setting: m[0].replace(/\s*:$/, ""), envVar: env ? env[1] ?? env[2] ?? env[3] : undefined });
  }
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]*(?:POOL|CONNECTION_LIMIT|CONN_LIMIT|MAX_CONN|DB_CONNECTIONS)[A-Z0-9_]*)/g)) {
    add("pool-setting", m.index, { setting: "env", envVar: m[1] });
  }

  // --- Interactive transactions ---------------------------------------------
  for (const m of src.matchAll(/\.\$transaction\s*\(\s*async\b/g)) {
    const open = src.indexOf("(", m.index + 1);
    const end = matchClose(src, open);
    const body = end === -1 ? "" : src.slice(open, end);
    const queries = (body.match(new RegExp(`\\.(?:${ORM_OPS}|\\$queryRaw|\\$executeRaw)\\s*[(\`]`, "g")) || []).length;
    const loops = (body.match(/\b(?:for|while)\s*\(|\.(?:forEach|map|flatMap)\s*\(/g) || []).length;
    const io = EXTERNAL_IO.exec(body);
    const timeout = /\b(timeout|maxWait)\s*:\s*([\d_]+)\s*,?\s*\}?\s*$/.exec(body.slice(-160));
    add(io ? "transaction-external-io" : "interactive-transaction", m.index, {
      queries,
      loops: loops || undefined,
      externalIo: io ? io[1] : undefined,
      timeout: timeout ? `${timeout[1]}=${timeout[2]}` : undefined,
    });
  }

  // --- Queries in loops and callbacks ---------------------------------------
  const loopRe = /\b(for\s*(?:await\s*)?\(|while\s*\()|\.(forEach|map|flatMap|reduce)\s*\(/g;
  for (const m of src.matchAll(loopRe)) {
    let bodyStart;
    let bodyEnd;
    let head = "";
    if (m[1]) {
      const headOpen = src.indexOf("(", m.index);
      const headClose = matchClose(src, headOpen);
      if (headClose === -1) continue;
      head = src.slice(headOpen, headClose);
      let j = headClose + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== "{") continue;
      bodyStart = j;
      bodyEnd = matchClose(src, j);
    } else {
      bodyStart = src.indexOf("(", m.index);
      bodyEnd = matchClose(src, bodyStart);
    }
    if (bodyEnd === -1) continue;
    const body = src.slice(bodyStart, bodyEnd);
    const q = DB_CALL.exec(body);
    if (!q) continue;
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    const parallel = !m[1] && /Promise\.(all|allSettled)\s*\(\s*[\w$.]*$/.test(before);
    const batched = !!m[1] && /\b(cursor|skip|offset)\s*:|\bOFFSET\b|\blastId\b|\bafter\s*:/i.test(body + head) && /\b(take|limit|first)\s*:|\bLIMIT\b|batchSize|BATCH/i.test(body + head);
    add(m[1] ? "query-in-loop" : "query-in-callback", bodyStart + q.index, {
      loop: (m[1] || m[2]).replace(/\s|\(/g, ""),
      parallel: parallel || undefined,
      batched: batched || undefined,
    });
  }

  // --- Unbounded findMany ----------------------------------------------------
  for (const fm of src.matchAll(/\.findMany\s*\(/g)) {
    const pre = /([\w$]+)\s*$/.exec(src.slice(Math.max(0, fm.index - 80), fm.index));
    const m = { index: pre ? fm.index - pre[0].length : fm.index, 1: pre ? pre[1] : "" };
    const a = callArgs(src, fm.index);
    if (!a) continue;
    const args = a.text;
    if (/\btake\s*:/.test(args) || /\.\.\.\s*\w*(paginat|page|limit|take)/i.test(args)) continue;
    if (/^\s*[\w$.]+\s*$/.test(args)) continue;
    if (/\bin\s*:/.test(args)) continue; // bounded by an id list
    if (/where\s*:\s*\{\s*(?:id|uuid|slug)\s*:\s*(?!\{)/.test(args)) continue; // unique-key filter
    const model = m[1] || undefined;
    const growth = !model ? 0 : opts.hotModels?.has(model.toLowerCase()) ? 3 : opts.models?.get(model.toLowerCase()) ?? 0;
    add("unbounded-findMany", m.index, { model, growth: growth || undefined });
  }

  // --- Queue workers ---------------------------------------------------------
  for (const m of src.matchAll(/new\s+Worker\s*(?:<[^>()]*>)?\s*\(/g)) {
    const a = callArgs(src, m.index);
    const args = a?.args ?? [];
    const optsArg = args.slice(2).join(",");
    const c = /concurrency\s*:\s*([\w.]+)/.exec(optsArg) ?? /concurrency\s*:\s*([\w.]+)/.exec(a?.text ?? "");
    const n = c && /^\d+$/.test(c[1]) ? Number(c[1]) : undefined;
    const proc = args[1] ?? "";
    let usesDb = DB_CALL.test(proc);
    const refs = [];
    if (!usesDb) {
      const path = /^(?:path\.(?:join|resolve)\([^)]*?)?["'`]([^"'`]+\.[cm]?[jt]s)["'`]/.exec(proc) ?? /["'`]([^"'`]+\.[cm]?[jt]s)["'`]\s*\)?\s*$/.exec(proc);
      const member = /^(?:this|[\w$]+)\.([\w$]+)(?:\.bind\s*\([^)]*\))?$/.exec(proc);
      if (path) refs.push({ path: path[1] });
      else if (/^[A-Za-z_$][\w$]*$/.test(proc)) refs.push({ name: proc });
      else if (member) refs.push({ name: member[1] });
      else for (const name of calledNames(proc)) refs.push({ name });
      // Only method calls (this.svc.run(job)) or nothing we can follow: say so instead of "no DB".
      if (!refs.length && proc && hasOpaqueCall(proc)) usesDb = "unknown";
    }
    add("queue-worker", m.index, { concurrency: n ?? (c ? c[1] : 1), usesDb, refs: refs.length ? refs : undefined });
  }
  for (const m of src.matchAll(/@Processor\s*\(/g)) {
    const a = callArgs(src, m.index);
    const c = /concurrency\s*:\s*([\w.]+)/.exec(a?.text ?? "");
    const n = c && /^\d+$/.test(c[1]) ? Number(c[1]) : undefined;
    const body = findFunctionBody(src, "process");
    const usesDb = body && DB_CALL.test(body) ? true : DB_CALL.test(src) ? "likely" : !body || hasOpaqueCall(body.slice(1)) ? "unknown" : false;
    add("queue-worker", m.index, { concurrency: n ?? (c ? c[1] : 1), usesDb, nest: true });
  }

  // --- Global middleware -----------------------------------------------------
  for (const m of src.matchAll(/\b(?:app|server|router)\.use\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    add("global-middleware", m.index, { middleware: m[1] });
  }

  // --- Scheduled jobs (by import, not by name) ------------------------------
  const sched = [];
  const schedAdd = (idx, via) => {
    const h = add("scheduled-job", idx, { via });
    if (h) sched.push(idx);
  };
  const nodeCron = moduleBindings(src, "node-cron");
  for (const a of nodeCron.ns) for (const m of src.matchAll(new RegExp(`\\b${esc(a)}\\.schedule\\s*\\(`, "g"))) schedAdd(m.index, "node-cron");
  for (const l of localFor(nodeCron, "schedule")) for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc(l)}\\s*\\(`, "g"))) schedAdd(m.index, "node-cron");
  const cronPkg = moduleBindings(src, "cron");
  for (const l of localFor(cronPkg, "CronJob")) for (const m of src.matchAll(new RegExp(`new\\s+${esc(l)}\\s*\\(|\\b${esc(l)}\\.from\\s*\\(`, "g"))) schedAdd(m.index, "cron");
  for (const a of cronPkg.ns) for (const m of src.matchAll(new RegExp(`new\\s+${esc(a)}\\.CronJob\\s*\\(|\\b${esc(a)}\\.(?:job|CronJob\\.from)\\s*\\(`, "g"))) schedAdd(m.index, "cron");
  const nodeSchedule = moduleBindings(src, "node-schedule");
  for (const a of nodeSchedule.ns) for (const m of src.matchAll(new RegExp(`\\b${esc(a)}\\.scheduleJob\\s*\\(`, "g"))) schedAdd(m.index, "node-schedule");
  for (const l of localFor(nodeSchedule, "scheduleJob")) for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc(l)}\\s*\\(`, "g"))) schedAdd(m.index, "node-schedule");
  const croner = moduleBindings(src, "croner");
  for (const l of [...croner.ns, ...localFor(croner, "Cron")]) for (const m of src.matchAll(new RegExp(`(?:new\\s+|(?<![\\w$.]))${esc(l)}\\s*\\(`, "g"))) schedAdd(m.index, "croner");
  if (moduleBindings(src, "agenda").any) for (const m of src.matchAll(/\.every\s*\(\s*["'`]/g)) schedAdd(m.index, "agenda");
  for (const m of src.matchAll(/@(Cron|Interval)\s*\(/g)) schedAdd(m.index, `@nestjs/schedule @${m[1]}`);
  for (const m of src.matchAll(/\b(cron\.schedule|new\s+CronJob|schedule\.scheduleJob)\s*\(/g)) schedAdd(m.index, "cron");
  for (const m of src.matchAll(/\.upsertJobScheduler\s*\(|\brepeat\s*:\s*\{/g)) schedAdd(m.index, "bullmq");
  if (moduleBindings(src, "bullmq").any) {
    for (const m of src.matchAll(/\b(?:every\s*:\s*[\d_]|pattern\s*:\s*["'`])/g)) {
      if (sched.some((i) => i < m.index && m.index - i < 300)) continue;
      schedAdd(m.index, "bullmq");
    }
  }

  // --- Socket handlers that hit the DB --------------------------------------
  const handlers = [];
  for (const m of src.matchAll(/\.on\s*\(\s*["'`]([^"'`]+)["'`]\s*,/g)) {
    const recv = /([\w$]*(?:[Ss]ocket|io|ws|nsp|[Nn]amespace))$/.exec(src.slice(Math.max(0, m.index - 60), m.index));
    if (!recv) continue;
    m[2] = m[1];
    m[1] = recv[1];
    m.index -= recv[1].length;
    const a = callArgs(src, m.index + m[1].length);
    if (a) handlers.push({ idx: m.index, start: a.open, end: a.close, event: m[2] });
  }
  for (const h of handlers) {
    const inner = handlers.filter((o) => o !== h && o.start > h.start && o.end < h.end);
    const body = src.slice(h.start, h.end);
    const direct = [...body.matchAll(DB_CALL_G())].some((q) => !inner.some((o) => h.start + q.index > o.start && h.start + q.index < o.end));
    if (direct) add("socket-handler-db", h.idx, { event: h.event });
  }
  for (const m of src.matchAll(/@SubscribeMessage\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const a = callArgs(src, m.index);
    if (!a) continue;
    const sig = /[\w$]+\s*\(/.exec(src.slice(a.close + 1, a.close + 300));
    if (!sig) continue;
    const pOpen = a.close + 1 + sig.index + sig[0].length - 1;
    const pClose = matchClose(src, pOpen);
    const body = pClose === -1 ? undefined : bodyFrom(src, pClose + 1);
    if (body && DB_CALL.test(body)) add("socket-handler-db", m.index, { event: m[1] });
  }

  // --- Redis -----------------------------------------------------------------
  const ioredis = moduleBindings(src, "ioredis");
  if (ioredis.any) {
    const ctors = new Set([...ioredis.ns, ...ioredis.named.keys()]);
    for (const m of src.matchAll(/new\s+([\w$]+(?:\.[\w$]+)?)\s*\(/g)) {
      const [head, tail] = m[1].split(".");
      if (!ctors.has(head) || (tail && tail !== "Cluster")) continue;
      const a = callArgs(src, m.index);
      if (a && !/commandTimeout/.test(a.text)) add("redis-no-timeout", m.index);
    }
  }
  for (const m of src.matchAll(/\.keys\s*\(\s*["'`][^"'`]*\*|\.(?:call|sendCommand|send_command)\s*\(\s*\[?\s*["'`]keys["'`]/gi)) add("redis-keys", m.index);

  // --- Page size taken from the request without a cap ------------------------
  const tainted = new Set();
  const taintedObj = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g)) {
    if (REQ_INPUT.test(m[2]) && !/Math\.min|clamp|\.max\s*\(/.test(m[2])) tainted.add(m[1]);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=\n]+)?=\s*(?:req|request|ctx(?:\.request)?)\.(?:query|body)\b/g)) {
    for (const part of m[1].split(",")) {
      const local = part.split("=")[0].split(":").pop().trim();
      if (/^[\w$]+$/.test(local)) tainted.add(local);
    }
  }
  for (const m of src.matchAll(/@Query\s*\(\s*["'`]([\w$]+)["'`][^)]*\)\s*([\w$]+)/g)) tainted.add(m[2]);
  for (const m of src.matchAll(/@Query\s*\(\s*\)\s*([\w$]+)/g)) taintedObj.add(m[1]);
  for (const v of [...tainted]) {
    if (new RegExp(`\\b${esc(v)}\\b[^;\\n]*Math\\.min|Math\\.min\\([^)]*\\b${esc(v)}\\b`).test(src)) tainted.delete(v);
  }
  const isTainted = (expr) => {
    if (/Math\.min|clamp/.test(expr)) return false;
    if (/\b(?:req|request|ctx(?:\.request)?)\.query\.\w+/.test(expr)) return true;
    for (const tok of expr.match(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*/g) ?? []) {
      if (tainted.has(tok) || tainted.has(tok.split(".")[0])) return true;
      if (taintedObj.has(tok.split(".")[0]) && tok.includes(".")) return true;
    }
    return false;
  };
  for (const m of src.matchAll(/\b(take|limit)\s*:\s*([^,}\n]+)/g)) {
    if (/^\s*(?:number|string|any)\b/.test(m[2])) continue;
    if (m[1] === "limit" && /\b(total\w*|hasNext\w*|hasMore|totalPages)\s*:/.test(src.slice(Math.max(0, m.index - 200), m.index + 200))) continue; // response metadata
    if (isTainted(m[2])) add("uncapped-take", m.index, { value: m[2].trim().slice(0, 60) });
  }
  for (const m of src.matchAll(/\.limit\s*\(\s*([^)]+)\)|\bLIMIT\s+\$\{([^}]+)\}/g)) {
    if (isTainted(m[1] ?? m[2])) add("uncapped-take", m.index, { value: (m[1] ?? m[2]).trim().slice(0, 60) });
  }

  // --- Client polling ----------------------------------------------------------
  if (CLIENT_DIR.test(file) || /\.(tsx|jsx)$/.test(file)) {
    const perRow = PER_ROW_FILE.test(file) || undefined;
    for (const m of src.matchAll(/\b(refetchInterval|pollingInterval)\s*:\s*([^,}\n]+)/g)) {
      const win = src.slice(Math.max(0, m.index - 300), m.index + 300);
      let unfocused;
      if (m[1] === "pollingInterval" && !/skipPollingIfUnfocused/.test(win)) unfocused = "no skipPollingIfUnfocused";
      if (m[1] === "refetchInterval" && /refetchIntervalInBackground\s*:\s*true/.test(win)) unfocused = "refetchIntervalInBackground";
      add("client-polling", m.index, { interval: m[2].trim(), perRow, unfocused });
    }
    for (const m of src.matchAll(/\bsetInterval\s*\(/g)) {
      const a = callArgs(src, m.index);
      if (!a) continue;
      const cb = a.args[0] ?? "";
      const fetches = /^[\w$.]+$/.test(cb) ? FETCHY_NAME.test(cb) : FETCHY_BODY.test(cb);
      if (fetches) add("client-polling", m.index, { interval: a.args[1], perRow });
    }
  }

  // --- In-memory sort after a query -------------------------------------------
  for (const m of src.matchAll(/\.sort\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    if (/findMany\s*\(/.test(before)) add("in-memory-sort-after-query", m.index);
  }

  // --- Process model (code side) -------------------------------------------------
  if (/^ecosystem\b/.test(basename(file)) || /\bexec_mode\s*:/.test(src)) {
    for (const m of src.matchAll(/\binstances\s*:\s*(["']?[\w-]+["']?)|\bexec_mode\s*:\s*["'](\w+)["']/g)) {
      add("process-model", m.index, { detail: m[1] ? `pm2 instances=${m[1].replace(/["']/g, "")}` : `pm2 exec_mode=${m[2]}` });
    }
  }
  for (const m of src.matchAll(/\bNODE_APP_INSTANCE\b/g)) add("process-model", m.index, { detail: "NODE_APP_INSTANCE gating: some work runs only on selected pm2 instances" });
  for (const m of src.matchAll(/\bcluster\.(fork|isPrimary|isMaster)\b/g)) add("process-model", m.index, { detail: `node:cluster (${m[1]})` });

  // --- Telemetry ---------------------------------------------------------------
  for (const [tool, re] of TELEMETRY) {
    const m = re.exec(src);
    if (m) add("telemetry", m.index, { tool });
  }

  return hits;
}

const TELEMETRY = [
  ["prom-client", /["']prom-client["']/],
  ["express-prom-bundle", /["']express-prom-bundle["']/],
  ["nestjs-prometheus", /["']@willsoto\/nestjs-prometheus["']/],
  ["OpenTelemetry", /["']@opentelemetry\/[\w-]+["']/],
  ["Datadog (dd-trace)", /["']dd-trace["']/],
  ["New Relic", /["']newrelic["']/],
  ["Sentry", /["']@sentry\/[\w-]+["']/],
  ["Elastic APM", /["']elastic-apm-node["']/],
  ["StatsD", /["'](?:hot-shots|node-statsd|statsd-client)["']/],
  ["/metrics endpoint", /["'`]\/metrics["'`]/],
  ["Prisma metrics", /\$metrics\.(?:prometheus|json)\s*\(/],
  ["event-loop delay monitor", /monitorEventLoopDelay\s*\(/],
];

// ---------------------------------------------------------------------------
// Non-code files

function scanInfraFile(src, file) {
  const starts = lineStarts(src);
  const hits = [];
  const add = (kind, idx, extra) => {
    if (isCommentAt(src, idx, true)) return;
    const line = lineAt(starts, idx);
    hits.push({ kind, file, line, code: redact(lineText(src, starts, line).trim()).slice(0, 140), ...extra });
  };
  const b = basename(file);
  if (/^Dockerfile|\.dockerfile$/i.test(b)) {
    for (const m of src.matchAll(/^[ \t]*(CMD|ENTRYPOINT)[ \t]+(.+)$/gm)) {
      if (/node|pm2|npm|yarn|pnpm|tsx|bun/.test(m[2])) add("process-model", m.index, { detail: `Dockerfile ${m[1]}` });
    }
  } else if (b === "Procfile") {
    for (const m of src.matchAll(/^([\w-]+):[ \t]*(.+)$/gm)) add("process-model", m.index, { detail: `Procfile ${m[1]}` });
  } else if (/\.ya?ml$/.test(b)) {
    for (const m of src.matchAll(/^[ \t]*(replicas|replicaCount|minReplicas|maxReplicas)[ \t]*:[ \t]*(\d+)/gm)) add("process-model", m.index, { detail: `${m[1]}=${m[2]}` });
    for (const m of src.matchAll(/^[ \t]*-?[ \t]*image[ \t]*:[ \t]*["']?[\w./-]*(prometheus|grafana|otel|opentelemetry-collector|jaeger|tempo|loki|datadog)/gim)) add("telemetry", m.index, { tool: `${m[1]} (container)` });
  } else if (b === "package.json") {
    for (const m of src.matchAll(/"([\w:-]+)"\s*:\s*"[^"]*pm2(?:-runtime)?\s+start[^"]*?(?:-i|--instances)\s+(\w+)/g)) add("process-model", m.index, { detail: `pm2 -i ${m[2]} in script "${m[1]}"` });
  }
  return hits;
}

function prismaModels(src) {
  const models = new Map();
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const body = m[2];
    const tenant = /^\s*(tenantId|customerId|organizationId|orgId|companyId|accountId|workspaceId|carrierId|brokerId|shipperId)\b/m.test(body);
    const grows = /^\s*(createdAt|timestamp|recordedAt|occurredAt)\b/m.test(body);
    if (tenant || grows) models.set(m[1].toLowerCase(), tenant ? 2 : 1);
  }
  return models;
}

function readOrUndefined(f) {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
}

function scanPrismaSchema(root, f) {
  const src = readOrUndefined(f);
  if (src === undefined) return { schema: { file: toPosix(relative(root, f)), unreadable: true, previewFeatures: [] }, models: new Map() };
  const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/s.exec(src)?.[1];
  const rawUrl = /datasource\s+\w+\s*\{[^}]*\burl\s*=\s*([^\n]+)/s.exec(src)?.[1]?.replace(/\s\/\/.*$/, "").trim();
  const url = rawUrl === undefined ? undefined : /^env\(\s*"[\w]+"\s*\)$/.test(rawUrl) ? rawUrl : "<literal URL redacted>";
  const preview = /previewFeatures\s*=\s*\[([^\]]*)\]/.exec(src)?.[1]?.replace(/["\s]/g, "").split(",").filter(Boolean) || [];
  return {
    schema: { file: toPosix(relative(root, f)), provider, url, previewFeatures: preview, relationJoins: preview.includes("relationJoins"), metrics: preview.includes("metrics") },
    models: prismaModels(src),
  };
}

function scanPrismaVersion(root, f) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const v = deps["@prisma/client"] ?? deps.prisma;
  return v ? { file: toPosix(relative(root, f)), version: v, adapters: Object.keys(deps).filter((d) => d.startsWith("@prisma/adapter-")) } : undefined;
}

function scanEnvFile(root, f) {
  const out = [];
  for (const line of (readOrUndefined(f) ?? "").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]*(?:DATABASE|DB|POSTGRES|MYSQL|PG)[A-Z0-9_]*URL)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2];
    out.push({
      file: toPosix(relative(root, f)),
      key: m[1],
      hasConnectionLimit: /connection_limit=/.test(v),
      hasPoolTimeout: /pool_timeout=/.test(v),
      hasPgbouncer: /pgbouncer=true/.test(v),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changed lines (PR mode)

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

/** Undo git's C-style quoting of unusual path names ("a\\tb", octal UTF-8 bytes). */
function unquoteGitPath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  const map = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[i + 1];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(map[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function changedLines(root, ref) {
  let base;
  try {
    base = git(root, ["merge-base", ref, "HEAD"]).trim();
  } catch {
    try {
      base = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    } catch {
      throw new Error(`--changed-since: cannot resolve "${ref}" in ${root} (is it a git repository, and is the ref fetched?)`);
    }
  }
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", base, "--"]);
  const files = new Map();
  let cur;
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      cur = undefined;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      const p = unquoteGitPath(line.slice(4).replace(/\t$/, ""));
      cur = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (cur && !files.has(cur)) files.set(cur, new Set());
      continue;
    }
    const h = header || cur ? /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line) : null;
    if (h) header = false;
    if (h && cur) {
      const s = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < n; i++) files.get(cur).add(s + i);
    }
  }
  for (const f of git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean)) files.set(f, "all");
  return { ref, base, files };
}

// ---------------------------------------------------------------------------
// Ranking

export const LEVELS = ["info", "low", "medium", "high"];

export function severityOf(h) {
  let s;
  switch (h.kind) {
    case "transaction-external-io":
    case "query-in-callback":
    case "uncapped-take":
    case "socket-handler-db":
    case "redis-keys":
      s = "high";
      break;
    case "query-in-loop":
      s = h.batched ? "low" : "high";
      break;
    case "interactive-transaction":
      s = h.loops ? "medium" : "low";
      break;
    case "unbounded-findMany":
      s = (h.growth ?? 0) >= 2 ? "medium" : "low";
      break;
    case "client-polling":
    case "prisma-extension":
    case "redis-no-timeout":
    case "in-memory-sort-after-query":
      s = "medium";
      break;
    default:
      return "info";
  }
  if (pathRank(h.file) === 3) s = LEVELS[Math.max(1, LEVELS.indexOf(s) - 1)];
  return s;
}

function score(h) {
  switch (h.kind) {
    case "unbounded-findMany":
      return h.growth ?? 0;
    case "interactive-transaction":
    case "transaction-external-io":
      return (h.loops ?? 0) * 100 + (h.queries ?? 0);
    case "query-in-loop":
    case "query-in-callback":
      return h.batched ? -1 : (h.depth ?? 1) + (h.parallel ? 1 : 0);
    case "client-polling":
      return (h.perRow ? 2 : 0) + (h.unfocused ? 1 : 0);
    default:
      return 0;
  }
}

function compareHits(a, b) {
  const ra = pathRank(a.file);
  const rb = pathRank(b.file);
  return (ra === 3) - (rb === 3) || score(b) - score(a) || ra - rb || a.file.localeCompare(b.file) || a.line - b.line;
}

// ---------------------------------------------------------------------------
// Repo scan

export function scanRepo(root, opts = {}) {
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`no such directory: ${root}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${root}`);

  const includes = (opts.include ?? []).map(globToRegExp);
  const excludes = (opts.exclude ?? []).map(globToRegExp);
  const all = [];
  walk(root, (p) => all.push(p));
  const rel = new Map(all.map((p) => [p, toPosix(relative(root, p))]));
  const files = all.filter((p) => {
    const r = rel.get(p);
    if (excludes.some((re) => re.test(r))) return false;
    return !includes.length || includes.some((re) => re.test(r));
  });

  const schemas = [];
  const models = new Map();
  for (const f of files) {
    if (basename(f) !== "schema.prisma" && !(extname(f) === ".prisma" && /(^|\/)prisma\//.test(rel.get(f)))) continue;
    const { schema, models: m } = scanPrismaSchema(root, f);
    if (basename(f) === "schema.prisma" || schema.provider) schemas.push(schema);
    for (const [k, v] of m) models.set(k, Math.max(models.get(k) ?? 0, v));
  }
  const hotModels = new Set((opts.hotModels ?? []).map((s) => s.toLowerCase()));

  const sources = new Map();
  const read = (abs) => {
    if (sources.has(abs)) return sources.get(abs);
    let s;
    try {
      s = statSync(abs).size <= MAX_FILE_BYTES ? readFileSync(abs, "utf8") : undefined;
    } catch {
      s = undefined;
    }
    sources.set(abs, s);
    return s;
  };

  const hits = [];
  const ignored = [];
  const skipped = { minified: 0, large: 0 };
  let scanned = 0;
  const workerFiles = new Map();
  for (const f of files) {
    const r = rel.get(f);
    const b = basename(f);
    if (!CODE_EXT.has(extname(f))) {
      if (/^Dockerfile|\.dockerfile$|^Procfile$|\.ya?ml$|^package\.json$/i.test(b) && !/lock\.ya?ml$/.test(b)) {
        const s = read(f);
        if (s !== undefined) hits.push(...scanInfraFile(s, r));
      }
      continue;
    }
    if (TEST_FILE.test(r)) continue;
    let size;
    try {
      size = statSync(f).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.large++;
      continue;
    }
    const src = read(f);
    if (src === undefined) continue;
    if (hasLongLine(src)) {
      skipped.minified++;
      continue;
    }
    scanned++;
    const fileHits = scanSource(src, r, { models, hotModels, ignored });
    if (fileHits.some((h) => h.refs)) workerFiles.set(r, f);
    hits.push(...fileHits);
  }

  // Resolve queue processors that are passed by name or path.
  for (const h of hits) {
    if (h.kind !== "queue-worker" || !h.refs) continue;
    const abs = workerFiles.get(h.file);
    let best = "unresolved";
    for (const ref of h.refs) {
      const ctx = { seen: new Set(), read };
      let r;
      if (ref.path) {
        const target = resolveModule(abs, ref.path.startsWith(".") ? ref.path : `./${ref.path}`);
        r = target ? analyzeDbUse(target, "default", 2, ctx) : "unresolved";
        if (r === "unresolved" && target && DB_CALL.test(read(target) ?? "")) r = "likely";
      } else {
        r = analyzeDbUse(abs, ref.name, 2, ctx);
      }
      best = stronger(best, r);
    }
    h.usesDb = best === "yes" ? true : best === "likely" ? "likely" : best === "no" ? false : "unknown";
    h.processor = h.refs.map((x) => x.name ?? x.path).join(", ");
    delete h.refs;
  }

  const prismaVersions = [];
  const env = [];
  for (const f of files) {
    const b = basename(f);
    if (b === "package.json") {
      const v = scanPrismaVersion(root, f);
      if (v) prismaVersions.push(v);
    } else if (EXAMPLE_ENV.test(b) || (opts.includeEnv && REAL_ENV.test(b))) {
      env.push(...scanEnvFile(root, f));
    }
  }

  let changed;
  let kept = hits;
  let ignoredKept = ignored;
  if (opts.changedSince) {
    changed = changedLines(root, opts.changedSince);
    kept = hits.filter((h) => {
      const s = changed.files.get(h.file);
      return s === "all" || (s instanceof Set && s.has(h.line));
    });
    ignoredKept = ignored.filter((h) => {
      const s = changed.files.get(h.file);
      return s === "all" || (s instanceof Set && s.has(h.line));
    });
  }
  for (const h of kept) {
    h.severity = severityOf(h);
    h.deployable = deployable(h.file);
  }
  kept.sort(compareHits);

  const summary = { high: 0, medium: 0, low: 0, info: 0 };
  for (const h of kept) summary[h.severity]++;
  const poolEnvVars = [...new Set(kept.filter((h) => h.kind === "pool-setting" && h.envVar).map((h) => h.envVar))];

  return {
    root,
    scanned,
    skipped,
    summary,
    changedSince: changed ? { ref: changed.ref, base: changed.base, files: changed.files.size } : undefined,
    includeEnv: !!opts.includeEnv,
    schemas,
    prismaVersions,
    env,
    poolEnvVars,
    ignored: ignoredKept,
    hits: kept,
  };
}

// ---------------------------------------------------------------------------
// Output

const SECTIONS = [
  ["telemetry", "Telemetry already in the repo", "Check these for real numbers (pool wait, p95, event-loop delay) before asking the user for metrics."],
  ["process-model", "Process model", "Replicas, pm2 instances, cluster mode and instance gating. Feeds the connection budget."],
  ["prisma-client", "PrismaClient instantiations", "Each one is a separate pool. More than one per process multiplies connections."],
  ["prisma-extension", "Prisma query extensions", "Run on every matching operation. Extra queries inside them multiply round trips and pool hold time."],
  ["pool-setting", "Explicit pool settings in code", "If none exist for a client, it runs on the driver/ORM default. Env-var settings live outside the repo."],
  ["queue-worker", "Queue workers (in-process concurrency)", "If these run in the API process they share its pool. Sum their concurrency into the connection budget."],
  ["scheduled-job", "Scheduled jobs", "Crons in the API process also share its pool."],
  ["global-middleware", "Global middleware", "Runs on every request. If it queries the database, every route queues for a connection, including trivial ones."],
  ["socket-handler-db", "Socket handlers that query the database", "Run per event per connected client; reconnect storms after deploys replay them all at once."],
  ["transaction-external-io", "Interactive transactions with external I/O inside", "Holds a connection across network calls. High pool-starvation risk."],
  ["interactive-transaction", "Interactive transactions", "Each holds one connection for the whole callback. Ranked by loops inside, then query count."],
  ["query-in-loop", "Queries inside loops (possible N+1)", "Check cardinality: how many iterations per request? Batched pagination loops are ranked last."],
  ["query-in-callback", "Queries inside map/forEach callbacks", "N+1 or unbounded parallel fan-out against the pool."],
  ["uncapped-take", "Page size taken from the request without a cap", "A caller can ask for any number of rows, and every per-row query multiplies with it."],
  ["unbounded-findMany", "findMany without take", "Ranked by whether the model grows per tenant/over time (from schema.prisma or --hot-models). Many are fine."],
  ["in-memory-sort-after-query", "In-memory sort shortly after a findMany", "Possible full read + JS sort on the request path."],
  ["redis-keys", "Redis KEYS with a pattern", "O(N) over the whole keyspace and blocks Redis. Use SCAN or a tracked set."],
  ["redis-no-timeout", "ioredis clients without commandTimeout", "A stalled Redis holds every awaiting request (and its DB connection) indefinitely."],
  ["client-polling", "Client polling / intervals", "Per-row polling multiplies server load by visible items × viewers. Only intervals that fetch are listed."],
];

function describe(h) {
  const extra = [];
  if (h.severity && h.severity !== "info") extra.push(h.severity);
  if (h.tool) extra.push(h.tool);
  if (h.detail) extra.push(h.detail);
  if (h.via) extra.push(h.via);
  if (h.queries !== undefined) extra.push(`${h.queries} queries`);
  if (h.loops) extra.push(`${h.loops} loop(s) inside`);
  if (h.externalIo) extra.push(`external I/O: ${h.externalIo}`);
  if (h.timeout) extra.push(h.timeout);
  if (h.concurrency !== undefined) extra.push(`concurrency ${h.concurrency}`);
  if (h.usesDb !== undefined) extra.push(h.usesDb === true ? "uses DB" : h.usesDb === "likely" ? "DB use likely (processor's file queries the DB)" : h.usesDb === "unknown" ? `processor not resolved: ${h.processor}` : "no DB call found");
  if (h.middleware) extra.push(h.middleware);
  if (h.event) extra.push(`event "${h.event}"`);
  if (h.loop) extra.push(`loop: ${h.loop}`);
  if (h.depth > 1) extra.push(`nested ×${h.depth}`);
  if (h.parallel) extra.push("inside Promise.all");
  if (h.batched) extra.push("batched pagination, likely intentional");
  if (h.model && h.kind === "unbounded-findMany") extra.push(`model ${h.model}${h.growth >= 3 ? " (hot)" : h.growth === 2 ? " (tenant-scaled)" : h.growth === 1 ? " (grows over time)" : ""}`);
  if (h.value) extra.push(`value: ${h.value}`);
  if (h.interval) extra.push(`interval ${h.interval}`);
  if (h.perRow) extra.push("per-row component");
  if (h.unfocused) extra.push(`polls when unfocused (${h.unfocused})`);
  if (h.setting) extra.push(h.envVar ? `${h.setting === "env" ? "pool" : h.setting} via env ${h.envVar}` : h.setting);
  if (h.adapter) extra.push("driver adapter");
  if (h.transactionOptions) extra.push(`transactionOptions { ${h.transactionOptions} }`);
  if (h.scope) extra.push(h.scope);
  if (h.extraQueries) extra.push("issues extra queries");
  return extra;
}

export function renderMarkdown(r, limit = 15) {
  const out = [];
  out.push(`# ScaleGuard static scan`);
  out.push(``);
  const skippedNote = r.skipped.minified || r.skipped.large ? ` Skipped ${r.skipped.minified} minified and ${r.skipped.large} oversized files.` : "";
  out.push(`Scanned ${r.scanned} source files under \`${r.root}\`.${skippedNote} These are **leads**; verify each in code.`);
  const s = r.summary;
  out.push(`Leads: ${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} context.${r.ignored.length ? ` ${r.ignored.length} silenced by scale-guard-ignore.` : ""}`);
  if (r.changedSince) out.push(`PR mode: only lines changed since \`${r.changedSince.ref}\` (merge-base ${r.changedSince.base.slice(0, 10)}, ${r.changedSince.files} files).`);
  out.push(``);

  if (!r.changedSince) {
    out.push(`## Prisma schemas`);
    if (!r.schemas.length) out.push(`None found.`);
    for (const x of r.schemas) out.push(x.unreadable ? `- \`${x.file}\`: unreadable, skipped` : `- \`${x.file}\`: provider=${x.provider ?? "?"}, url=${x.url ?? "?"}, relationJoins=${x.relationJoins}, metrics=${x.metrics}`);
    out.push(``);
    out.push(`## Prisma versions`);
    if (!r.prismaVersions.length) out.push(`Not found. Pool defaults depend on the major version (≤6: built-in pool, physical_cpus*2+1; 7 / driver adapters: the driver's pool). State the assumption.`);
    for (const v of r.prismaVersions) out.push(`- \`${v.file}\`: ${v.version}${v.adapters.length ? `, adapters: ${v.adapters.join(", ")}` : ""}`);
    out.push(``);
    out.push(`## Database URLs in env files (values never shown)`);
    const envNote = r.poolEnvVars.length ? `pool size set in code via env ${r.poolEnvVars.join(", ")} (value outside the repo)` : undefined;
    if (!r.env.length) {
      out.push(r.includeEnv ? `None found.` : `None in .env.example/.sample/.template (real .env files not read; pass --include-env).`);
      out.push(envNote ? `Pool: ${envNote}.` : `Production env is usually outside the repo: treat pool size as unknown/inferred.`);
    }
    for (const e of r.env) {
      const cl = e.hasConnectionLimit ? "set" : envNote ? `absent in URL; ${envNote}` : "ABSENT";
      out.push(`- \`${e.file}\` ${e.key}: connection_limit=${cl}, pool_timeout=${e.hasPoolTimeout ? "set" : "absent"}${e.hasPgbouncer ? ", pgbouncer=true" : ""}`);
    }
    out.push(``);
  }

  const deps = new Map();
  for (const h of r.hits) {
    if (h.severity === "info") continue;
    const d = deps.get(h.deployable) ?? { high: 0, medium: 0, low: 0 };
    d[h.severity]++;
    deps.set(h.deployable, d);
  }
  if (deps.size > 1) {
    out.push(`## Leads by deployable`);
    out.push(`| Deployable | High | Medium | Low |`);
    out.push(`|---|---|---|---|`);
    for (const [d, c] of [...deps].sort((a, b) => b[1].high - a[1].high || b[1].medium - a[1].medium)) out.push(`| ${d} | ${c.high} | ${c.medium} | ${c.low} |`);
    out.push(``);
  }

  const workers = r.hits.filter((h) => h.kind === "queue-worker");
  if (workers.length) {
    const numeric = workers.filter((w) => typeof w.concurrency === "number");
    const sum = (ws) => ws.reduce((t, w) => t + w.concurrency, 0);
    const db = numeric.filter((w) => w.usesDb === true || w.usesDb === "likely");
    const unknown = numeric.filter((w) => w.usesDb === "unknown");
    out.push(`Queue workers: ${workers.length}; summed numeric concurrency: ${sum(numeric)}, of which DB-using (seen or likely): ${sum(db)}${unknown.length ? `, unresolved: ${sum(unknown)}` : ""}${numeric.length < workers.length ? ` (+${workers.length - numeric.length} with non-literal concurrency)` : ""}.`);
    out.push(``);
  }

  for (const [kind, title, note] of SECTIONS) {
    const list = r.hits.filter((h) => h.kind === kind);
    if (!list.length) continue;
    out.push(`## ${title} (${list.length})`);
    out.push(`_${note}_`);
    out.push(``);
    for (const h of list.slice(0, limit)) {
      const extra = describe(h);
      out.push(`- \`${h.file}:${h.line}\`${extra.length ? ` (${extra.join(", ")})` : ""} — \`${h.code}\``);
    }
    if (list.length > limit) out.push(`- … ${list.length - limit} more (use --limit or --json)`);
    out.push(``);
  }
  if (!r.hits.length) out.push(r.changedSince ? `No new leads on changed lines.` : `No leads.`);
  return out.join("\n");
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      json: { type: "boolean" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      "hot-models": { type: "string", multiple: true },
      "include-env": { type: "boolean" },
      "changed-since": { type: "string" },
      "fail-on": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals[0]) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  const limit = values.limit === undefined ? 15 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit must be a non-negative integer, got "${values.limit}"`);
  const failOn = values["fail-on"];
  if (failOn !== undefined && !["high", "medium", "low"].includes(failOn)) throw new Error(`--fail-on must be high, medium or low, got "${failOn}"`);
  const r = scanRepo(resolve(positionals[0]), {
    include: splitList(values.include),
    exclude: splitList(values.exclude),
    hotModels: splitList(values["hot-models"]),
    includeEnv: values["include-env"],
    changedSince: values["changed-since"],
  });
  process.stdout.write((values.json ? JSON.stringify(r, null, 2) : renderMarkdown(r, limit)) + "\n");
  if (failOn) {
    const min = LEVELS.indexOf(failOn);
    const failing = r.hits.filter((h) => LEVELS.indexOf(h.severity) >= min);
    if (failing.length) {
      process.stderr.write(`scan-repo: ${failing.length} lead(s) at or above ${failOn}\n`);
      return 1;
    }
  }
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
