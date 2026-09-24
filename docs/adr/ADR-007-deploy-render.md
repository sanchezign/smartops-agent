# ADR-007: Deploy everything on Render (Blueprint)

Date: 2026-09-24
Status: accepted

## Decision

Deploy target `render`: `api` (web service + worker), `admin` (web service,
instead of Vercel), `n8n` (Docker image service) and Render Postgres (one
instance, separate `n8n` database), all declared in a `render.yaml` Blueprint.
`prisma migrate deploy` runs on release.

## Reason

One platform, one bill and one Blueprint for the whole system, which is easier to
hand over to a client. n8n needs a long-running Docker service, which Render
supports.

## Consequences

- Render free web services spin down after 15 minutes without traffic and free
  Postgres databases expire 30 days after creation (checked in the Render docs
  on 2026-09-24). The webhook receiver, the worker and n8n therefore need paid
  instances in production; background workers have no free tier.
- Plans and monthly cost are re-checked against current Render pricing in
  phase 12 and documented in the README.
- The admin panel loses Vercel-specific optimizations; acceptable for an
  internal, noindex panel.
