# Investigation Workflow and Evidence Standards

## Evidence labels

- **Confirmed:** directly supported by a reproducible trace, query plan, metric, or code path plus relevant workload context.
- **Likely:** strong code or configuration evidence, but runtime confirmation is missing.
- **Speculative:** plausible explanation requiring more data.

## Diagnostic sequence

1. Establish symptom and scope.
2. Map endpoint/job/query call path.
3. Collect available runtime evidence.
4. Inspect code and SQL.
5. Identify candidate bottlenecks.
6. Rank by impact/confidence/effort/risk.
7. Propose diagnostic follow-ups for uncertain items.
8. Request approval for changes.
9. Implement narrowly.
10. Validate with comparable workload and correctness tests.

## Prioritisation

Use a qualitative matrix, not fake precision:
- Impact: user-visible latency, throughput, reliability, cost.
- Confidence: strength of evidence.
- Effort: implementation and rollout complexity.
- Risk: correctness, data integrity, operational blast radius.

A high-impact but speculative issue may deserve measurement before implementation. A confirmed low-risk issue may be a good quick win.

## Avoid false certainty

Never claim:
- "missing index" from a sequential scan node alone;
- "N+1" without repeated per-record queries or evidence;
- "database is the bottleneck" from endpoint latency alone;
- "increase pool size" without a connection budget;
- "parallelise" without checking dependencies and capacity;
- "cache it" without consistency and invalidation design;
- "optimised" without before/after measurements.

## Evidence collection requests

Ask for redacted:
- endpoint trace;
- query text and query plan;
- table/index definitions;
- `pg_stat_statements` aggregates;
- pool metrics;
- event-loop and CPU profiles;
- workload and deployment topology.

Do not ask users to upload secrets or raw customer data.
