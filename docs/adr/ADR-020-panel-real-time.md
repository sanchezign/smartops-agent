# ADR-020: Panel real time: database triggers, one LISTEN connection per API process, SSE

Date: 2026-09-27
Status: accepted

## Context

The panel (phase 9) must show changes as they happen: new messages, who is answering, reviews,
pipeline runs, alerts and catalog changes. Changes come from several processes: the API, the
pg-boss worker, CLI scripts, and n8n through the internal API. The user required (phase 9
addendum 3):

- one LISTEN connection per API process that fans events out in memory to every SSE
  connection, never a Postgres connection per client;
- a cap on SSE connections per user.

## Decision

- **Source: Postgres triggers** (migration `realtime_events`). They cover `messages`,
  `media_files`, `conversations`, `contacts`, `review_items`, `ingestion_runs` and `alerts`
  per row, and `products` per statement using a transition table (a 2,000-row ingest emits one
  event per statement). Each trigger runs `pg_notify('smartops_events', …)`:
  - Every writer is covered with no code in the writers.
  - NOTIFY is transactional: an event is only delivered after COMMIT, and a rollback emits
    nothing.

  Payload = event type + ids + status. **Never content** (no text, names or phone numbers), so
  it stays far under NOTIFY's 8,000-byte limit. Prisma does not model triggers: keep them when
  editing these tables.
- **One listener per API process** (`events/pg-listener.ts`): a dedicated `pg.Client` outside
  the pool, `LISTEN smartops_events`. It reconnects with backoff from 1 s to 30 s. Events sent
  while it was down are lost, so after reconnecting it tells every stream to **resync**.
  Payloads are re-validated with Zod (`panel-events.ts`); unknown types and extra fields are
  dropped.
- **In-memory hub** (`events/event-hub.ts`):
  - fans each event out to every SSE connection of the process;
  - coalesces them per connection for 250 ms, so identical events are sent once;
  - caps connections: `SSE_MAX_STREAMS_PER_USER` (5: tabs plus phone) and `SSE_MAX_STREAMS`
    (500 per process). Over the cap → 429 `TOO_MANY_STREAMS`;
  - one broken socket never stops the fan-out;
  - on shutdown every stream is ended with `session: server_restart`, so `server.close()` does
    not hang.
- **`GET /api/v1/events`** (SSE):
  - Bearer required. The panel opens it with `fetch()`, because EventSource cannot send
    headers, and parses the stream itself (`lib/sse.ts`). A `?token=` query parameter is never
    accepted.
  - Headers: `text/event-stream`, `no-store, no-transform`, `X-Accel-Buffering: no`,
    `retry: 5000`.
  - Frames: `ready`, `events` (a batch), `resync`, `session`, and `: ping` comments.
  - **Heartbeat** every `SSE_HEARTBEAT_SECONDS` (25) re-checks the SESSION
    (`AuthService.checkSession`), not the 15-minute JWT. A revoked or expired session, a
    deactivated user or a role change ends the stream with `session: ended | role_changed`.
    The panel then refreshes: on success it reconnects with the new token and role; on failure
    it goes to the login.
- **Panel** (`features/realtime/`):
  - One stream per tab.
  - Each event invalidates only the TanStack queries it affects (`keysFor`; prefixes merged,
    batched every 200 ms). The data is then refetched through the normal authenticated API,
    so role rules keep applying.
  - Every **re**-connection invalidates everything.
  - Backoff from 1 s to 30 s with ±20 % jitter. The panel retries at once when the tab becomes
    visible again or the network comes back online.
  - While not live, the conversation queries poll every 30 s as a fallback.
  - An "En vivo / Reconectando…" indicator (`role=status`) is shown in the top bar.
- **Proxies**:
  - The panel reaches the API through the same `/api` proxy: the Next rewrite in development,
    in E2E and in deploy option A; Caddy in option D. Verified in E2E with a production
    `next start` in Chromium and WebKit.
  - Caddy flushes `text/event-stream` responses immediately, whatever `flush_interval` is set
    to (Caddy `reverse_proxy` docs).

## Consequences

- Real time costs one Postgres connection per API process plus one socket per open tab, with
  no Redis and no extra service ($0).
- Events are hints, not data: missing one is harmless because the next reconnection or resync
  refetches everything. There is no replay (`Last-Event-ID` is ignored).
- Several API instances each LISTEN on their own; NOTIFY reaches all of them.
- The worker opens no listener: it only writes, and the triggers announce its changes.
- Triggers add a small cost to each write on those tables (a `pg_notify` per row, or per
  statement for products).
