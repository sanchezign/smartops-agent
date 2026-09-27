# ADR-021: Public demo: DEMO_MODE with the real pipeline, fakes and no Meta

Date: 2026-09-27
Status: accepted

## Context

The portfolio needs a public demo that costs $0 and needs no WhatsApp account (cost
constraint, phase 12). A visitor with no account of their own must be able to see the whole
flow live (the "Probar el sistema" page, user 2026-09-25):

- a supplier message arrives;
- media is downloaded, transcribed or read;
- AI extraction runs;
- the catalog is updated, or items go to review.

Until now production refused every fake (Graph API, LLM, transcriber). The user decided in the
phase 9 plan that the demo is an explicit mode, with four addenda:

- the demo operator's credentials are visible on the login screen;
- that operator has no access to users or critical rules;
- a test guarantees that no real WhatsApp message can ever leave;
- the demo data resets automatically.

## Decision

**`DEMO_MODE=true`** (API **and** worker). It is applied in `parseEnv` BEFORE validation,
whatever the other variables say:

- **Fakes forced:**
  - `AI_PROVIDER=fake`, reading the recorded outputs in `apps/api/demo/golden`. These are
    byte-identical to the test goldens, and a test enforces it.
  - `TRANSCRIPTION_PROVIDER=fake`, reading `demo/transcripts/<sha256>.txt`.
  - `WHATSAPP_GRAPH_BASE_URL` = the demo's own Graph API (`DEMO_GRAPH_URL`, default
    `http://127.0.0.1:PORT`).

  With DEMO_MODE, the production "no fakes" rules do not apply. That is the ONLY exception.
- **No real WhatsApp, at every layer (tested):**
  - `GraphApiConfig.blockMeta`: `graphRequest` refuses Meta hosts (facebook.com, fbsbx.com,
    fbcdn.net, whatsapp.com/.net, meta.com and their subdomains) BEFORE any network call.
  - Media downloads accept only the demo host.
  - The environment forces the base URL.

  Tests cover a careless deploy that leaves Meta/Anthropic/Groq variables set:
  `test/unit/demo-mode.test.ts`.
- **A \*_demo database is required** (`DATABASE_URL` name must end in `_demo`), because the demo
  resets its data.
- **The demo's own Graph API**, served by the API (`demo/demo-graph.ts`):
  - same paths, auth and error shapes as Meta;
  - media metadata and signed short-lived download URLs from an in-memory store;
  - `POST /messages` returns a wamid and sends signed status webhooks (sent / delivered /
    read) to our own webhook;
  - nothing leaves the process.
- **"Probar el sistema"** (`POST /api/v1/demo/inject`, login + rate limit):
  - six samples: photo, PDF, voice note, known spreadsheet, new spreadsheet and prompt
    injection;
  - each is built like Meta's payload (the builders moved from the simulator into
    `src/modules/demo/wa-payloads.ts`, shared with it) and POSTed SIGNED to our webhook, so
    the rest is the real pipeline: worker, download, transcription or conversion, n8n,
    extraction, catalog, reviews;
  - `GET /demo/trace/:wamid` drives the panel's live timeline.
- **Sample assets** (`apps/api/demo/assets`):
  - the photo, PDF and spreadsheets are the test fixtures;
  - the voice note is a valid 5 s Ogg/Opus generated in code (`demo-audio.ts`, no binary in
    the repo).

  The seed prepares the senders so that the recorded outputs line up:
  - "Distribuidora Demo S.A." with the catalog of the recorded September PDF;
  - "Distribuidora Ejemplo S.R.L." with its spreadsheet format ALREADY APPROVED (fast $0
    path, no mapper);
  - "Mayorista del Este" without a format (column review).
- **Access:**
  - `GET /api/v1/demo/info` (public, only in DEMO_MODE) gives the demo operator's PUBLIC
    credentials to the login screen.
  - The operator role has no settings writes and no users, and the API enforces it.
- **Reset:**
  - "Reiniciar demo" (`POST /demo/reset`, login + 5 per 10 min) and an automatic reset every
    `DEMO_RESET_INTERVAL_MINUTES` (default 60; each reset reschedules the next).
  - Both re-run the seed with `keepAuth`: users, sessions and refresh tokens are kept, the
    demo users get their public password back, and every other table is refilled.
- **E2E:** the Playwright API runs in DEMO_MODE with the real worker and a stand-in for n8n
  (`scripts/demo/e2e-n8n.ts`, the same calls as the exported workflows). Every sample is
  tested end to end in the browser.

## Consequences

- The public demo runs the same code as production, at $0: no Meta account, no AI spend, no
  transcription quota.
- The recorded outputs only cover the sample files. Any other content sent in demo mode gets
  the fake responders (low-confidence answers → review), never a real model.
- In-memory demo media is lost on restart. Old demo messages then show "no se pudo
  descargar", and the periodic reset cleans them up.
- A real deployment must keep `DEMO_MODE=false` (the default). The *_demo database rule makes
  it impossible to point the demo at real data by accident.
