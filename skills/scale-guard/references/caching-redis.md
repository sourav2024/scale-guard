# Caching and Redis

## Decide whether a cache is the right fix

Caching hides cost; it does not remove it. Fix pathological queries and unbounded work first. A cache is appropriate when the same expensive result is read far more often than it changes and some staleness is acceptable.

Before recommending a cache, write down:
- source of truth and acceptable staleness;
- cache key, including **tenant and authorization boundaries** (never share a key across tenants or permission sets);
- invalidation strategy (TTL, explicit delete on write, versioned keys);
- stampede protection (single-flight/lock, early refresh, jittered TTL);
- memory bound and eviction policy;
- behaviour when Redis is down or slow (fail open to the source with a timeout, never hang the request).

## Fragile cache keys

A key fingerprinted on "latest `updatedAt`" or "row count" invalidates on every write to any matching row. On busy tables the hit rate collapses exactly at peak. Measure hit rate before trusting a cache in a diagnosis.

## Redis bottlenecks

Signals: command latency (`LATENCY`, `SLOWLOG GET`), CPU of the single Redis thread, `connected_clients`, `blocked_clients`, evictions, network bandwidth.

Common causes:
- `KEYS *` or large `SCAN` loops in request paths;
- very large values (multi-MB JSON) serialized per request;
- many round trips where a pipeline or `MGET` would do;
- hot keys;
- blocking commands on the shared connection;
- one connection used for both pub/sub and commands.

Client side (`ioredis`, `node-redis`): check command timeouts, offline queue behaviour (commands queue silently while disconnected), reconnect strategy, and `maxRetriesPerRequest`.

## Validation

Report hit rate, latency with and without cache, memory used, and correctness under writes (stale reads, cross-tenant isolation tests).
