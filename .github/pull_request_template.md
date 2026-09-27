## What and why

<!-- One or two sentences: what changes and why. Link the phase / milestone or issue. -->

## How it was tested

<!-- Commands run, manual checks, screenshots for panel changes (mobile first). -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test:fast`
- [ ] Integration / E2E where relevant (CI runs them on pull requests to `main`)

## Checklist

- [ ] Conventional Commit messages (`feat:`, `fix:`, `ci:`, `docs:` …) — the changelog is built from them
- [ ] No secrets, `.env` files, real phone numbers or customer data in the diff
- [ ] `.env.example` updated for every new variable
- [ ] New API routes under `/api/v1/`, validated with Zod, covered by the authorization matrix
- [ ] Migrations versioned; hand-written SQL (CHECKs, triggers, partial indexes) listed in `migrations.test.ts`
- [ ] Internal route schema or `message.ready` payload changed → `pnpm --filter @smartops/api n8n:contract`
- [ ] Anything that could generate charges (paid plans, APIs, real LLM calls) was approved first
- [ ] Stack deviation → ADR in `docs/adr/` + `CLAUDE.md` updated
- [ ] Docs updated (README, `docs/`, `CLAUDE.md` current phase)
