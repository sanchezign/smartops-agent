# ADR-002: n8n for multi-agent orchestration

Date: 2026-09-24
Status: accepted

## Decision

Self-hosted n8n (Docker image pinned by tag, currently `2.40.6`, Postgres-backed
in its own `n8n` database and role) orchestrates the three agents: receiver
(classify), processor (extract + ingest) and notifier (alerts). n8n calls the
backend as tools and never writes to the application database.

- backend → n8n: n8n Webhook nodes protected by a shared-secret header.
- n8n → backend: `/api/v1/internal/*` with `X-Internal-Api-Key`, never exposed
  to the frontend.
- Workflows exported as JSON to `n8n/workflows/{receiver,processor,notifier}.json`,
  without credentials.

## Reason

Visual, inspectable agent workflows are part of the product pitch, and let a
client adjust orchestration without redeploying the API. Security, idempotency,
validation and catalog rules stay in the backend so they are testable and cannot
be bypassed from a workflow.

## Consequences

- `N8N_ENCRYPTION_KEY` must be fixed forever per environment (it encrypts stored
  credentials).
- One more service to run and pay for in production (no sleep: it receives
  webhooks from the API).
- Workflow changes are made in the n8n UI by a human and exported back to the
  repo; the agent only delivers drafts and node-by-node instructions.
- Upgrading n8n means changing the pinned tag deliberately and re-testing workflows.
