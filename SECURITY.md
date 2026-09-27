# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- While the repository is private: contact the maintainer through their GitHub profile.
- Once it is public: use GitHub's **private vulnerability reporting** (Security → Report a
  vulnerability).

Include what you found, how to reproduce it, and the impact you expect. You will get an
acknowledgement within 7 days.

## Supported versions

Only the latest release (`main`) receives security fixes. The project is pre-1.0: `v1.0.0` is
reserved for the audited public demo.

## What the project does to stay safe

- **No real keys in CI.** Tests and the browser E2E run with fake values; `DEMO_MODE` forces
  the fake LLM, fake transcriber and a local Graph API. The only CI credential is the automatic,
  least-privilege `GITHUB_TOKEN`.
- **Secrets:** every push is scanned with [gitleaks](https://github.com/gitleaks/gitleaks)
  (new commits) and the whole history is scanned weekly. Exceptions live in `.gitleaks.toml`,
  one file + value pair each, never a whole folder.
- **Dependencies:** `pnpm audit` blocks HIGH/CRITICAL advisories in production dependencies.
  Accepted exceptions live in `security/audit-exceptions.json`, each with a justification and an
  expiry date (an expired one blocks again). Renovate proposes updates after a minimum release
  age; Dependabot alerts are enabled.
- **CI supply chain:** every GitHub Action is pinned to a full commit SHA, tool images are
  pinned by digest, workflows run with `permissions: {}` by default and are checked by
  actionlint and zizmor.
- **Application:** see `docs/testing.md` (security tests: token forgery, rate limits, log
  safety, prompt injection) and the ADRs in `docs/adr/`.
