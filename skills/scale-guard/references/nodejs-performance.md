# Node.js Performance Diagnostic Guide

## Separate latency components

For a request, distinguish:
- ingress/load-balancer/network time;
- application queueing and event-loop delay;
- middleware, auth, validation;
- database pool wait;
- SQL execution and lock wait;
- downstream HTTP/RPC;
- CPU transformations and serialization;
- response transfer.

A slow endpoint is not automatically a slow SQL query.

## Code inspection

Look for:
- synchronous filesystem, crypto, compression, or CPU-heavy work on the event loop;
- large JSON parsing/stringifying and response payloads;
- sequential awaits for independent I/O;
- unbounded `Promise.all` fan-out;
- N+1 database calls inside loops;
- repeated work and avoidable allocations;
- missing timeouts, cancellation, backpressure, and bounded queues;
- retries without jitter/budget that amplify load;
- per-request client/connection construction;
- listeners, timers, and resources not cleaned up.

## Measurement

Where available, request:
- event-loop delay histogram and event-loop utilization;
- CPU profiles/flamegraphs;
- heap snapshots and GC metrics (handle sensitive data carefully);
- request traces with span timings;
- per-route latency percentiles and throughput;
- downstream and database timings;
- active requests, queue depth, timeout and retry counts.

Use representative staging traffic. Profilers and instrumentation can add overhead; document it.

## Concurrency and parallelism

Parallelise only independent work and bound concurrency. Increasing concurrency can worsen:
- database pool saturation;
- downstream rate limits;
- memory use;
- CPU contention;
- tail latency.

Preserve ordering and transaction semantics. Do not parallelise operations that depend on prior results or must be atomic.

## Worker threads and background jobs

Consider worker threads for sustained CPU-bound JavaScript, not ordinary asynchronous I/O. Consider a queue for work that need not block the user request. Include idempotency, retries, dead-letter handling, backpressure, and observability in any queue recommendation.

## HTTP clients and retries

Check keep-alive/socket reuse, per-host socket limits, connection establishment, DNS/TLS overhead, timeouts, cancellation, and retry policy. Avoid retrying non-idempotent operations without an idempotency strategy. Use retry budgets and jitter; retries during overload can create cascading failure.

## Validation

Compare p50/p95/p99, throughput, errors, CPU, memory, event-loop delay, and downstream timings under the same workload. Averages alone hide tail latency.
