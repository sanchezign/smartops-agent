# ADR-003: pg-boss for async jobs

Date: 2026-09-24
Status: accepted

## Decision

Use pg-boss (the `express-postgres` profile queue) for webhook processing,
retries with backoff, and scheduled jobs (e.g. reactivating the bot after the
human-takeover timeout).

## Reason

Meta requires a fast 2xx on webhook delivery; processing (media download,
transcription, n8n call) must happen outside the request. pg-boss stores jobs in
the Postgres we already run, so no Redis is needed locally or on Render.

## Consequences

- Webhook handler: verify signature → store raw → ack 200 → enqueue.
- Worker runs as a separate process or Render worker; it must be deployed and
  monitored like any service.
- Job load adds writes to the main Postgres; acceptable at MVP scale.
- Permanently failed jobs are logged and visible for manual retry.
