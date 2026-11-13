# Client Amplification

The server can be correct and still be overloaded because clients send more requests than users need. Look at the frontend and mobile clients whenever request rate grows faster than active users, or bursts line up with a page opening.

## Patterns

| Pattern | What it looks like in code | Effect |
|---|---|---|
| Per-item polling | A component rendered per row/card with its own `setInterval`, `refetchInterval`, or `pollingInterval` | N requests per interval per viewer |
| Per-item detail fetch | A list renders, then each row fetches its own detail/status | N+1 at the HTTP layer |
| Refetch-everything on events | Each realtime/socket event invalidates a whole list or all pages of an infinite list | Load proportional to event rate × open pages |
| Retry storms | Retries without backoff/jitter, or on non-retryable errors | Load multiplies exactly when the server is struggling |
| Reconnect storms | All sockets reconnect at once after a deploy | Burst of auth + subscription queries |
| Background tabs | Polling continues in hidden tabs | Constant load from idle users |
| Duplicate mounts | Same query mounted by several components with different keys | Duplicate requests |

## How to inspect

- Search the client for polling and interval primitives: `setInterval`, `refetchInterval`, `pollingInterval`, `useInterval`, `refetchOnWindowFocus`, socket event handlers that invalidate or refetch.
- For list pages, check whether row components issue their own queries.
- Count requests per page view in a browser devtools session or automated browser, for 1–2 minutes, with realistic list sizes.
- Server side: group request logs by user/session and route per minute; look for one user generating dozens of identical requests.

## Remedies (ranked by typical cost)

1. Batch endpoint: one request for all visible ids instead of one per row.
2. Raise intervals; pause polling for hidden tabs and off-screen rows.
3. Push instead of poll where a realtime channel already exists.
4. Invalidate narrowly: refetch only affected items or pages.
5. Exponential backoff with jitter; retry only idempotent requests and retryable status codes.
6. Jittered reconnect delays.

Validate with the same request-count measurement before and after, and confirm the UI still shows timely data.
