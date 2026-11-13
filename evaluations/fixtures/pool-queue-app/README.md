# Fixture: pool-queue-app

Synthetic Express + Prisma (MySQL) service used by the scanner tests and by scenario S11.
It is never run. It contains planted issues:

- no `connection_limit` on `DATABASE_URL` (Prisma default pool);
- BullMQ workers with concurrency 10 + 10 + 5 started inside the API process;
- a list endpoint with a wide `include` tree and an in-memory sort over an unbounded `findMany`;
- an N+1 loop in a report endpoint;
- an interactive transaction that calls an external HTTP API;
- a per-row polling component in the web client.
