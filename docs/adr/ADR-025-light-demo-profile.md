# ADR-025: Light demo profile (in-process orchestrator, API + worker in one process)

Date: 2026-10-02
Status: accepted

## Context

The public demo must fit a 1 GB VM (ADR-023). n8n alone needs ~350–490 MiB and the API and the
worker are two Node processes (~265 MiB together), so the full stack does not fit.

## Decision

In **DEMO_MODE only**:

- `DEMO_ORCHESTRATOR=internal` replaces the n8n webhook with an **in-process orchestrator**
  behind the same seam (`N8nClient.send`): it plays the three workflows (receiver → processor →
  notifier) over the internal API, exactly like the E2E stand-in. Default `n8n` (real system).
- A **combined entry** runs the API, the worker and the orchestrator in one Node process.
- "Probar el sistema" samples are processed **one at a time** (concurrency 1) on top of the
  existing per-IP and global caps, so several visitors cannot saturate 1/8 of a CPU.
- A **parity test** checks that the orchestrator makes the same internal calls as the exported
  n8n workflows for every classification.
- The README and the docs say that the public demo uses the light orchestrator and the real
  system uses n8n.

## Consequences

- Measured: API + worker in one process saves ~190 MiB of memory demand (423 vs 610 MiB under
  the 550 MiB cap). Memory tuning of Postgres, glibc and heaps gained nothing.
- Two implementations of the same flow exist (n8n workflows and the orchestrator); the parity
  test and the n8n contract test keep them aligned.
- One crash takes down API and worker together; acceptable for a demo (restart policy).
- Production keeps separate processes and n8n; nothing changes for a real client.
