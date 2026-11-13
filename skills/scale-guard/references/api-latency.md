# API Latency Investigation Guide

## Start with percentiles

Collect p50, p90, p95, and p99 latency, throughput, error rate, and request volume by route. Averages can hide tail latency. Segment by status code, tenant/customer class where safe, payload size, and dependency.

## Trace the critical path

For one representative request, map spans:
1. load balancer / ingress;
2. middleware, auth, validation;
3. service methods;
4. database pool acquire;
5. SQL execution and lock wait;
6. cache and downstream calls;
7. serialization and response transfer.

Identify the longest critical-path component and queueing. Avoid adding all span durations if work overlaps.

## Common API-level causes

- N+1 queries;
- serial independent calls;
- no pagination/limit;
- large response payloads;
- repeated expensive authorization or transformation;
- slow external services;
- retries/timeouts causing amplification;
- event-loop blocking;
- pool wait and lock contention;
- cache stampedes or ineffective cache keys.

## Cache decisions

Before recommending cache, define:
- source of truth;
- acceptable staleness;
- invalidation strategy;
- cache key and tenant/auth boundaries;
- stampede protection;
- memory bounds and eviction;
- behaviour on cache failure.

Caching is not a substitute for correcting a pathological query or unbounded workload.

## Report exact evidence

For every claim, identify route, code location, trace/log/metric, and confidence. If no tracing exists, propose the smallest instrumentation change to distinguish components.
