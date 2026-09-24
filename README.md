# SmartOps Agent

Multi-channel operations agent with AI. Suppliers, customers and staff send
information over WhatsApp in chaotic formats (text, PDFs, photos, voice notes);
SmartOps extracts structured data with Claude, keeps a product catalog up to
date, alerts the team and coexists with human operators on the same number.

> Status: **phase 1 — scaffold**. See `CLAUDE.md` for the full phase plan and
> `docs/pitch.md` for the original pitch.

## Repository layout

```
apps/
  api/            Express 5 + TypeScript (ESM) — webhook, queue, AI, catalog, internal API
  admin/          Next.js 15 admin panel (noindex)
n8n/workflows/    Exported n8n workflows (no credentials)
docker/postgres/  Postgres init scripts for local dev
docs/adr/         Architecture Decision Records
docker-compose.yml  Local infra: Postgres 17 + n8n
```

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 12 (`corepack enable` picks the version from `packageManager`)
- Docker Desktop (Compose v2)

## Setup

```bash
# 1. Dependencies (single lockfile at the root)
pnpm install

# 2. Environment
cp .env.example .env                        # docker-compose (Postgres + n8n)
cp apps/api/.env.example apps/api/.env      # API
cp apps/admin/.env.example apps/admin/.env.local
#    Replace every "change-me". Generate N8N_ENCRYPTION_KEY once and never change it:
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    DATABASE_URL in apps/api/.env must use POSTGRES_USER / POSTGRES_PASSWORD.

# 3. Local infrastructure
docker compose up -d
docker compose ps        # postgres and n8n should become "healthy"

# 4. Apps
pnpm dev                 # api on http://localhost:4000, admin on http://localhost:3000
```

n8n UI: http://localhost:5678 (create the owner account on first visit).
Postgres: `localhost:5432`, databases `smartops` (app) and `n8n` (n8n).
Both ports are published on `127.0.0.1` only.

### ⚠️ The Postgres init script only runs on a fresh volume

`docker/postgres/init/01-create-n8n-db.sh` creates the `n8n` role and database.
The official Postgres image runs scripts in `/docker-entrypoint-initdb.d`
**only when the data volume is created for the first time**. If the volume
already exists, changes to the script, or to `N8N_DB_*` / `POSTGRES_*` in `.env`,
are **ignored**.

To apply them you must recreate the volume, which **deletes all local data**
(app database and n8n workflows/credentials; export workflows first):

```bash
docker compose down -v   # destructive: removes postgres_data and n8n_data
docker compose up -d
```

Alternatively, create the role/database manually with `psql` on the existing volume.

## Scripts (root)

| Script              | What it does                            |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Runs every app in watch mode (parallel) |
| `pnpm build`        | Builds every app                        |
| `pnpm lint`         | ESLint in every app                     |
| `pnpm typecheck`    | `tsc --noEmit` in every app             |
| `pnpm test`         | Vitest (API)                            |
| `pnpm format`       | Prettier write                          |
| `pnpm format:check` | Prettier check                          |

Per app: `pnpm --filter @smartops/api <script>` / `pnpm --filter @smartops/admin <script>`.

## Environment variables (phase 1)

| Variable                    | Where        | Purpose                                              |
| --------------------------- | ------------ | ---------------------------------------------------- |
| `POSTGRES_USER/PASSWORD/DB` | root `.env`  | Postgres superuser and app database                  |
| `N8N_DB_NAME/USER/PASSWORD` | root `.env`  | n8n database and role (created on first volume init) |
| `N8N_ENCRYPTION_KEY`        | root `.env`  | Encrypts n8n credentials — never change it           |
| `N8N_WEBHOOK_URL`           | root `.env`  | Public base URL n8n uses for webhook URLs            |
| `TIMEZONE`                  | root `.env`  | n8n timezone (default `America/Montevideo`)          |
| `NODE_ENV`, `PORT`          | `apps/api`   | Runtime mode and HTTP port (default 4000)            |
| `DATABASE_URL`              | `apps/api`   | Postgres connection string (used from phase 2)       |
| `NEXT_PUBLIC_API_URL`       | `apps/admin` | Base URL of the API                                  |

## Architecture decisions

- [ADR-001](docs/adr/ADR-001-pnpm-monorepo.md) — pnpm workspaces monorepo
- [ADR-002](docs/adr/ADR-002-n8n-orchestration.md) — n8n for multi-agent orchestration
- [ADR-003](docs/adr/ADR-003-pg-boss-queue.md) — pg-boss for async jobs
- [ADR-004](docs/adr/ADR-004-claude-api.md) — Claude API for classification and extraction
- [ADR-005](docs/adr/ADR-005-whisper-transcription.md) — Whisper-compatible speech-to-text
- [ADR-006](docs/adr/ADR-006-no-oauth.md) — No OAuth, JWT only
- [ADR-007](docs/adr/ADR-007-deploy-render.md) — Deploy everything on Render
