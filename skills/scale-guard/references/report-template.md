# ScaleGuard Report Templates

Use the full template for audits. Use the short template when the user asks for a quick answer or gives a word limit.

## Short template

```
**Diagnosis (confidence):** one sentence.
**Signature:** which pattern from symptom-signatures.md, and the evidence that matches it.
**Evidence:** 3–6 bullets, each with file:line, metric, or plan node.
**Do next:** numbered; first item is the cheapest confirmation if confidence < Confirmed. Each item names its owner (agent / developer / operator).
**Not the cause:** what the evidence rules out.
**Unknowns:** what would change the diagnosis.
```

## Full template

### 1. Executive summary
- Scope:
- Environment:
- Main symptom:
- Signature matched:
- Overall confidence:
- Top recommendation:

### 2. Request/workload path
Route/job/query path, key dependencies, and everything sharing the same pool.

### 3. Findings
For each finding:

#### [Finding title]
- Severity: Critical / High / Medium / Low
- Confidence: Confirmed / Likely / Speculative
- Evidence: file:line, trace, metric, SQL plan node, or config
- Root cause or hypothesis:
- Missing evidence:
- Recommendation:
- Trade-offs and risks:

### 4. Prioritised action plan

| # | Action | Owner | Impact | Confidence | Effort | Risk |
|---|---|---|---|---|---|---|

### 5. Proposed changes
Exact files, queries, indexes, or settings. Not applied without approval.

### 6. Validation plan
- Baseline workload and environment:
- Metrics:
- Correctness/regression checks:
- Success criteria:
- Rollback:

### 7. Unknowns and assumptions
Every assumption made in autonomous mode, and what would change the diagnosis.
