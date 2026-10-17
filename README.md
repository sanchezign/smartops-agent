English · [Español](README.es.md)

# SmartOps Agent

**An AI operations agent for businesses that run on WhatsApp.** Suppliers, customers and staff
send price lists, orders and questions in every format: text, photos of printed lists, PDFs,
spreadsheets, voice notes. SmartOps reads them, keeps the product catalog up to date, asks a
person when something is doubtful, and tells the team only what needs action. People can take
over any chat at any moment.

> Status: built to production standards and tested end to end. **The public demo is live:**
> [https://smartops-demo.duckdns.org](https://smartops-demo.duckdns.org) (sample data, free, resets every hour). The login screen shows the shared
> demo account; "Try the system" sends sample messages through the real pipeline.

> **Public demo vs the real system.** The public demo runs on a 1 GB free VM, so it uses a light
> in-process orchestrator instead of n8n (and API + worker in one process). The real system uses
> n8n; a parity test checks that both make the same calls ([ADR-025](docs/adr/ADR-025-light-demo-profile.md)).

## See it

![The demo flow: a photo of a printed price list goes through the real pipeline and updates the catalog; a new spreadsheet format waits for a person; a person takes over a chat; the panel switches to Spanish](docs/media/demo.gif)

The screenshots follow your GitHub theme (light or dark).

| Home                                                                                                                                                                                                                                                                                                                  | To do                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-dashboard-dark.webp"><img alt="The Home: what waits for you first (the newest decisions and See all), then the chats a person is handling and the automation of the period" src="docs/media/desktop-dashboard-light.webp"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-todo-dark.webp"><img alt="To do: one card per supplier message with its decisions as questions, one-click answers with the value (Change to / Keep) and the messages to check" src="docs/media/desktop-todo-light.webp"></picture> |
| **Choosing a spreadsheet's price column**                                                                                                                                                                                                                                                                             | **Price history**                                                                                                                                                                                                                                                                                                   |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-review-columns-dark.webp"><img alt="A review of a new spreadsheet format: each price column shows real values from the file, and the suggested one is pre-selected" src="docs/media/desktop-review-columns-light.webp"></picture>    | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-product-dark.webp"><img alt="A product's price history as a step chart, with every change and the message that caused it" src="docs/media/desktop-product-light.webp"></picture>                                                   |
| **A conversation**                                                                                                                                                                                                                                                                                                    | **Activity**                                                                                                                                                                                                                                                                                                        |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-chat-dark.webp"><img alt="A supplier's chat filling the screen: a suspicious message, a spreadsheet and the newest messages, with the reply box fixed at the bottom" src="docs/media/desktop-chat-light.webp"></picture>             | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/desktop-activity-dark.webp"><img alt="Activity: the news of what the system already did, grouped by day (today, yesterday, dates), each with a link to the product" src="docs/media/desktop-activity-light.webp"></picture>                |

On a phone (mobile first):

| Home                                                                                                                                                                                                                                | To do                                                                                                                                                                                                                                  | Conversations                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/iphone-dashboard-dark.webp"><img alt="The Home on an iPhone: what waits for you first" src="docs/media/iphone-dashboard-light.webp" width="260"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/iphone-todo-dark.webp"><img alt="To do on an iPhone, with the To do counter in the bottom bar" src="docs/media/iphone-todo-light.webp" width="260"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/iphone-inbox-dark.webp"><img alt="The inbox on an iPhone: the filters (Needs a reply, A person is handling it) and a dot on the chat that waits for a reply" src="docs/media/iphone-inbox-light.webp" width="260"></picture> |

## What it does

- **Reads every format.** It takes text, photos, PDFs and Word files, reads spreadsheets by code
  once their format is known, and transcribes voice notes. Claude extracts the prices with
  structured, validated output.
- **Keeps the catalog right.** It matches products even when names differ, applies price changes,
  records the history, and tells full lists apart from partial updates. Prices keep their currency
  (the catalog's is a setting, USD by default) and are never converted. It flags outliers, currency
  and tax changes, and products missing from a full list.
- **Never guesses.** Anything doubtful becomes a review item for a person, next to the original
  message: an uncertain match, a suspicious message, a new spreadsheet format, an unclear voice
  note. In the public demo, the shared operator account can resolve every review.
- **Tells you what to do.** One To do list holds everything that waits for a person — the only
  yellow number in the panel — each decision a plain question, with a one-click answer when there
  is nothing to choose. News (Activity) and errors (System status) are kept apart.
- **Works with people.** Chats that wait for a person's reply are marked, and an open chat fills
  the screen with the reply box at the bottom. A person's reply pauses only the bot's automatic
  answers in that chat. Opt-out keywords are respected; the team gets one WhatsApp summary per window.
- **Costs little to run.** A deterministic pre-filter keeps greetings, stickers and customer chat
  away from the AI. Known spreadsheet formats cost $0. Spend caps are checked before every AI call.
  Total AI spend while building the whole project: **~$0.32**.

## How it works

```mermaid
flowchart LR
  WA["WhatsApp"] -->|signed webhook| API["API<br/>(Express, Postgres queue)"]
  API --> W["Worker<br/>media, audio, documents"]
  W -->|message ready| N8N["n8n<br/>receiver → processor → notifier"]
  N8N -->|internal API| API
  API <-->|structured output| AI["Claude"]
  API -->|real-time events| Panel["Admin panel<br/>(Next.js, EN / ES)"]
```

The backend owns every rule and every write; n8n orchestrates the three agents as visual
workflows. Every step is idempotent, so retries never duplicate anything. Details:
[docs/architecture.md](docs/architecture.md).

## Engineering highlights

| Area          | What is in place                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reliability   | Webhook stored before the 200 answer, a transactional outbox to n8n, queues with backoff and dead letters, idempotency at every step                                             |
| AI safety     | Documents are data, never instructions; outputs validated with Zod; detected injections stop for review. Real-model evaluation: 8/8 cases passed (6 attacks, 2 controls)         |
| Security      | Signed webhooks, rotating refresh sessions with reuse detection, Argon2id, CSRF checks, roles, masked logs, secret scanning ([more](docs/security.md))                           |
| Tests         | API: 1,453 unit and HTTP tests + 250 against a real Postgres. Panel: 247 unit tests + 187 browser tests (desktop Chrome, Pixel 7, iPhone / WebKit) with axe. Mutation score 80 % |
| CI/CD         | GitHub Actions: lint, types, tests, coverage gate, E2E, image scans; release-please; amd64 + arm64 images                                                                        |
| Languages     | Panel in English and Spanish, chosen per user; WhatsApp texts in the business's language                                                                                         |
| Accessibility | Mobile first, WCAG 2.1 AA checked with axe in both languages                                                                                                                     |

## Tech stack

| Layer          | Technology                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| Backend        | Node.js 24, Express 5, TypeScript, Zod, Prisma 7, PostgreSQL 17, pg-boss               |
| AI             | Claude (Anthropic SDK), Whisper on Groq, behind swappable provider interfaces          |
| Orchestration  | n8n (self-hosted)                                                                      |
| Frontend       | Next.js 15, React 19, Tailwind CSS 4, shadcn/ui, TanStack Query, next-intl             |
| Messaging      | WhatsApp Business Cloud API                                                            |
| Tooling        | pnpm workspaces, Vitest, Playwright, ESLint, Prettier, GitHub Actions, Docker          |
| Hosting (demo) | Oracle Cloud Always Free micro VM, Caddy, Docker Compose — $0 ([costs](docs/costs.md)) |

## Run it locally

Requirements: Node.js 24, pnpm 12 and Docker. No Meta account is needed: a local simulator
stands in for WhatsApp.

```bash
pnpm install
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/admin/.env.example apps/admin/.env.local
docker compose up -d
pnpm --filter @smartops/api db:migrate
pnpm dev   # API on :4000 + worker, panel on :3000
```

The full guide (environment variables, the WhatsApp simulator, the demo mode, tests):
[docs/development.md](docs/development.md).

## Documentation

All documents are listed in [docs/README.md](docs/README.md). The main ones:

- [Panel guide](docs/guide/panel-guide.md) — every screen, for the business owner and the team
- [Case study](docs/case-study.md) — the problem, the approach, measured results, lessons
- [Architecture](docs/architecture.md) — components, the path of a message, the data model
- [Security](docs/security.md) — controls, sessions, the demo server, known limits
- [Costs](docs/costs.md) — the $0 demo and an estimate for a real client
- [Development](docs/development.md) — setup, scripts, environment variables
- [Testing](docs/testing.md) and [CI/CD](docs/ci-cd.md)
- [Architecture decision records](docs/adr/)

## License

Copyright (c) 2026 Ignacio Sánchez ([sanchezign](https://github.com/sanchezign)). All rights reserved: this
repository is shared for portfolio review only. See [LICENSE](LICENSE).
