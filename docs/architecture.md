# Architecture

SmartOps Agent turns the messages that suppliers, customers and staff send over WhatsApp
(text, photos, PDFs, spreadsheets, voice notes) into an up-to-date product catalog, alerts and
a review queue. The decisions behind each part are recorded as ADRs in [docs/adr](adr/).

## Components

```mermaid
flowchart LR
  subgraph Meta["Meta"]
    WA["WhatsApp Cloud API"]
  end
  subgraph Server["Server (one VM, Docker Compose)"]
    Caddy["Caddy (HTTPS, one origin)"]
    API["API (Express 5)<br/>webhook, panel API, SSE"]
    Worker["Worker (pg-boss)<br/>media, transcription, conversion,<br/>outbound, digests"]
    PG[("PostgreSQL 17<br/>data + queues + media")]
    N8N["n8n<br/>receiver, processor,<br/>notifier, errors"]
    Panel["Admin panel (Next.js 15)"]
  end
  Claude["Claude API<br/>(classify, extract, map columns)"]
  Groq["Groq Whisper<br/>(voice notes)"]
  People["Team (browser, phone)"]

  WA -- "signed webhook" --> Caddy --> API
  API -- "store + enqueue" --> PG
  Worker <--> PG
  Worker -- "download media, send messages" --> WA
  Worker -- "audio" --> Groq
  Worker -- "message.ready (outbox)" --> N8N
  N8N -- "internal API (API key)" --> API
  API -- "structured output" --> Claude
  People --> Caddy --> Panel
  Panel -- "/api/v1 (JWT)" --> API
  API -- "SSE events" --> Panel
```

- **API** (`apps/api`, Express 5 + TypeScript + Prisma): the WhatsApp webhook, the internal API
  that n8n calls, the panel API, and real-time events (SSE). It owns every rule, all validation
  and every write.
- **Worker** (same code base, `node dist/worker.js`): pg-boss jobs for webhook processing, media
  download, transcription, document conversion, outbound messages, n8n delivery and digests.
- **PostgreSQL**: application data, the pg-boss queues (schema `pgboss`) and media bytes (ADR-008).
- **n8n** (self-hosted): orchestrates the three agents (receiver → processor → notifier) as
  visual workflows. It never touches the database; it only calls the backend (ADR-002, ADR-015).
- **Admin panel** (`apps/admin`, Next.js 15): reviews, conversations, catalog, alerts, rules and
  users. It runs in English or Spanish (ADR-024).
- **Claude** classifies messages, extracts price lists and maps new spreadsheet formats, always
  through structured outputs that are validated again with Zod (ADR-011).
- **Groq** transcribes voice notes (Whisper), behind a `Transcriber` interface (ADR-010).

## The path of a message

```mermaid
sequenceDiagram
  autonumber
  participant WA as WhatsApp Cloud API
  participant API as API
  participant DB as PostgreSQL (+ pg-boss)
  participant W as Worker
  participant N as n8n
  participant AI as Claude
  WA->>API: POST /api/v1/webhooks/whatsapp (X-Hub-Signature-256)
  API->>API: verify the signature over the raw body
  API->>DB: store the event (dedupe by body SHA-256) + enqueue
  API-->>WA: 200 OK (always fast)
  DB->>W: job
  W->>DB: message (unique waMessageId), contact, conversation
  W->>WA: download media (checksum, type, size checks)
  W->>W: transcribe audio · convert documents
  W->>DB: message.ready event (outbox, same transaction)
  W->>N: deliver message.ready (secret header, retries ~24 h)
  N->>API: POST /internal/classify
  Note over API: deterministic pre-filter first: greetings,<br/>stickers, customers… never reach the AI
  API->>AI: classify (only if needed)
  N->>API: POST /internal/extract
  API->>AI: extract (or read a known spreadsheet by code)
  N->>API: POST /internal/catalog/ingest
  API->>DB: rules: duplicates, outliers, currency, tax basis,<br/>full vs partial list → prices + review items
  N->>API: POST /internal/notifications
  API->>DB: actionable items → panel + one WhatsApp digest per window
```

Every step is idempotent: a repeated webhook, a retried job or a repeated n8n call never
creates a second message, run, price change or notification.

## Design choices

| Concern            | Choice                                                                                                                            | ADR      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Webhooks           | Signature over the raw body, store before 200, queue, idempotency by event hash and by `waMessageId`                              | 003      |
| Hand-off to n8n    | Transactional outbox (`integration_events`), retries for ~24 h, a watchdog, manual replay                                         | 015      |
| AI cost            | Deterministic pre-filter, known spreadsheet formats read without AI, spend caps checked before each call, a ledger per call       | 011, 014 |
| AI safety          | Documents are data (tagged, neutralized); outputs validated with Zod; injection attempts stop the run for a person                | 011      |
| Doubtful decisions | Never guessed: review items (uncertain matches, outliers, currency or tax changes, new formats, suspicious messages)              | 012      |
| People and the bot | A human reply pauses only automatic replies to that contact; processing and team alerts go on                                     | 016      |
| Consent            | Opt-in for business-initiated messages; deterministic opt-out keywords; gated at the outbound service                             | 009, 017 |
| Panel security     | Short-lived JWT in memory, rotating refresh cookie with reuse detection, Argon2id, CSRF checks, roles, one origin                 | 018      |
| Real time          | Postgres triggers → one LISTEN per API process → SSE to every open panel                                                          | 020      |
| Public demo        | `DEMO_MODE`: the real pipeline with fake AI, transcriber and Graph API; it refuses real keys and any non-demo database            | 021      |
| Languages          | Panel in English and Spanish (per user); WhatsApp texts in the business language                                                  | 024      |
| CI/CD              | GitHub Actions: quick checks on every push; coverage, E2E and image checks on PRs; amd64 + arm64 images scanned before publishing | 022      |

## Data model (core)

```mermaid
erDiagram
  Supplier ||--o{ Product : sells
  Supplier ||--o{ Contact : "is reached through"
  Contact ||--|| Conversation : has
  Conversation ||--o{ Message : contains
  Message ||--o| MediaFile : carries
  MediaFile ||--o| Transcription : "audio →"
  MediaFile ||--o| DocumentConversion : "document →"
  Message ||--o{ IngestionRun : "is processed in"
  IngestionRun ||--o{ PriceChange : writes
  IngestionRun ||--o{ ReviewItem : "asks a person"
  IngestionRun ||--o{ Alert : raises
  Product ||--o{ PriceChange : "history of"
  Supplier ||--o{ SupplierSheetFormat : "remembered formats"
```

Money is `Decimal(18,4)` (never a float) and is sent as a JSON string. Ids are UUIDv7. Some
integrity rules live in hand-written SQL (CHECK constraints, partial unique indexes, triggers)
and are listed in `apps/api/test/integration/migrations.test.ts`.

## Code layout

```
apps/api/src/
  app.ts, server.ts, worker.ts   composition (no listen in app.ts), HTTP bootstrap, worker bootstrap
  config/env.ts                  the only entry point for environment variables (Zod)
  common/                        errors, logger, middleware, business texts, JSON helpers
  ai/                            LLM provider interface, Anthropic + fake providers, prompts/*.md
  modules/<feature>/             routes → controller → service → repository (only repositories touch Prisma)
apps/admin/src/
  app/                           routes ((auth) login, (main) panel), error and not-found pages
  features/<feature>/            components, hooks, pure logic (unit-tested), types
  i18n/                          language resolution, request config, en/es messages
  lib/                           API client, formatting, number inputs
n8n/workflows/                   exported workflows (no credentials)
deploy/                          the server bundle (Compose, Caddyfile, scripts)
```
