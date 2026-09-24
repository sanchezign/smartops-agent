# ADR-001: pnpm workspaces monorepo

Date: 2026-09-24
Status: accepted

## Decision

One repository with pnpm workspaces: `apps/api` (Express), `apps/admin` (Next.js),
`n8n/workflows` (exported workflows) and `docs/adr`. Root scripts `dev`, `build`,
`lint`, `typecheck` and `test` run in every app (`pnpm -r --if-present`). A single
root `pnpm-lock.yaml`; apps never have their own lockfile or git repo.

## Reason

Portfolio project delivered as a single unit: one clone, one install, one CI
pipeline, and atomic changes across API, panel and workflows. pnpm is the
standard package manager of the stack.

## Consequences

- CI and Render builds run from the repo root and filter by package
  (`pnpm --filter @smartops/api ...`).
- Dependency build scripts must be allowed explicitly in `pnpm-workspace.yaml`
  (`allowBuilds`, pnpm >= 11).
- Shared tooling (Prettier, base tsconfig) lives at the root; each app owns its
  ESLint config.
- ESLint is pinned to 9.x across the repo because `eslint-config-next@15.5`
  only supports ESLint <= 9 (ESLint 9 is marked deprecated upstream; revisit
  when upgrading Next).
