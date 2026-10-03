# Security

How SmartOps Agent protects messages, credentials and the people who use it. To report a
vulnerability, see [SECURITY.md](../SECURITY.md). Each control below is covered by automated
tests unless noted.

## Entry points

| Entry point                   | Protection                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp webhook              | HMAC-SHA256 (`X-Hub-Signature-256`) over the **raw** body with the app secret (constant-time compare); verify token in constant time; 3 MB body cap; its own rate limit; invalid → 401 |
| Internal API (n8n)            | `X-Internal-Api-Key` (hashed, constant-time compare), strict Zod bodies, its own rate limit; never reachable from the internet on the demo server (the proxy answers 404)              |
| Panel API (`/api/v1/admin/*`) | Bearer access token + role on every route, declared in one table; a test compares the served routes with it, and an authorization matrix checks anonymous / operator / admin           |
| Login                         | Generic error, per-IP limit, account lockout with growing waits (capped at 1 h), Argon2id with a dummy hash for unknown emails                                                         |
| Real-time stream (SSE)        | Bearer only; the session is re-checked on every heartbeat (a logout or a role change closes the stream); caps per user and in total                                                    |

## Panel sessions (ADR-018)

- Access token: HS256 JWT, 15 minutes, kept in memory only (never in storage); `exp`, `iat` and
  `sub` are required.
- Refresh token: 256 random bits, stored as a SHA-256 hash, sent as an `HttpOnly`,
  `SameSite=Strict` cookie limited to `/api/v1/auth`; rotated on every use. Reusing an old one
  ends the whole session (RFC 9700), with a 10-second grace for parallel tabs.
- Sessions expire after 24 h idle and 7 days in total. Every request re-reads the session and the
  user, so logout-all, deactivation and role changes apply at once.
- CSRF on the cookie routes: a custom header plus an Origin allowlist, and cross-site fetches are
  refused.
- Passwords: 15–128 characters, no composition rules, blocked if common or if they contain the
  person's email or name (NIST SP 800-63B / OWASP). Only an administrator creates users; the
  first admin is created from the server's command line.
- Roles: operators resolve product lines and conversations; administrators also resolve whole
  lists, change rules and manage users. Nobody changes their own role, and the last active
  admin cannot be removed.
- Not yet: multi-factor authentication (TOTP), which is planned before a real client.

## Data handling

- **Validation**: every input is validated with Zod (bodies, params, queries, settings, model
  outputs). Money is a decimal string, never a float.
- **Media**: download URLs are only followed to Meta's hosts, and the access token is only sent
  there; file type (magic bytes), size and checksum are checked; the panel downloads media with
  the session and shows it from `blob:` URLs (no token in a URL). Files are served with
  `nosniff`, a sandboxing CSP and `Cross-Origin-Resource-Policy`.
- **Documents**: spreadsheets and Word files are converted in an isolated worker thread with
  memory and time limits and a ZIP-bomb guard.
- **AI input**: documents and messages are data, never instructions. They are wrapped in tags,
  and look-alike tags are neutralized after Unicode normalization. Outputs are schema-validated.
  A suspected injection stops the run for a person. The real-model evaluation passed 8/8 cases
  (OWASP LLM Top 10 as a guide).
- **AI spend**: a worst-case estimate is checked against total, daily, per-contact and per-run
  caps before every call; every call is recorded with its tokens and cost.
- **Logs**: phone numbers and user ids are masked; message bodies, names, tokens and keys never
  reach a log line (tested with the production logger at trace level). Sensitive headers are
  redacted.
- **Consent**: business-initiated messages need an opt-in; an opt-out keyword blocks every
  automatic message except the single confirmation.
- **Speech-to-text privacy**: every Groq account must have Zero Data Retention enabled (without
  it, Groq may keep audio and transcripts for up to 30 days).

## Secrets and supply chain

- Secrets only in environment files outside the repository; required ones are checked at startup
  and the process exits if one is missing or too short.
- gitleaks scans every new commit, and the full history every week. The Docker images are
  checked for environment files, keys and secret-looking strings before they are published.
- GitHub Actions: every action pinned by full commit SHA, tool images by digest, least-privilege
  permissions per job, and workflows linted with actionlint and zizmor.
- Dependencies: a `pnpm audit` gate (high / critical in production dependencies block, with
  dated exceptions), Renovate with a minimum release age, and install scripts allowed only for
  reviewed packages. Trivy scans the images' OS packages.
- No real key is ever given to CI; the AI evaluation runs only on a developer machine, with an
  explicit spend confirmation.

## The public demo server

The demo server is live at https://smartops-demo.duckdns.org. This section describes its configuration, which is tested
end to end on a local copy of the deployment (`scripts/deploy/local-harness.sh`) and checked from
outside on the live server (`scripts/deploy/demo-abuse-check.mjs`).

- It runs with `DEMO_MODE`: fake AI, fake transcriber and its own Graph API. It refuses to start
  if any real key (Anthropic, Groq, Meta) is present, and refuses any database whose name does
  not end in `_demo`.
- Only the reverse proxy (Caddy) is exposed, on ports 80 and 443. It sends HSTS, `nosniff`,
  Referrer-Policy, frame protection and a Content-Security-Policy.
- The n8n editor is disabled, and n8n is reachable only inside the server's network. SSH goes
  through OCI Bastion.
- The shared public operator cannot change passwords, roles or its saved language, cannot
  close other visitors' sessions, and is never locked out (a per-IP limit protects it). A demo
  reset is limited to once per 10 minutes for everyone.
- Backups are encrypted with `age`; the private key lives only on the owner's computer. They go to a
  private Object Storage bucket that the server can only **append** to: it cannot overwrite, delete or
  read a backup (ADR-026); `backup-selftest.sh` proves it.
- Measured on the live server (2026-10-03): admin, internal and webhook routes answer 401 / 404; a
  2 MB JSON body gets 413 (refused at the proxy above 1 MiB); the login limit still answers 429 when a
  client sends a different `X-Forwarded-For` on every attempt; the event-stream, global and sample
  limits answer 429; 100 health requests, ten at a time, took p95 294 ms.
- MDN HTTP Observatory (2026-10-03): **B+ (80)**, 11 of 12 tests passed. The only deduction is
  `'unsafe-inline'` in `script-src` (-20): Next.js hydrates with inline scripts. Why the demo stays at
  B+, and what it would take to go higher: see "Why the public demo stays at B+" below.

## Why the public demo stays at B+

The Content-Security-Policy allows `'unsafe-inline'` for scripts and styles because the Next.js panel
hydrates with inline scripts and the charts use inline styles. Everything else in the policy is strict
(same-origin only, no framing, no objects, `upgrade-insecure-requests`), and the other eleven Observatory
tests pass. A decision, not an oversight (2026-10-03):

- **What it would take:** a per-request nonce policy. A Next.js middleware generates a nonce on every request
  and sends `script-src 'self' 'nonce-…' 'strict-dynamic'`; Next puts the nonce on its own inline scripts; the
  charts' inline `style` attributes need a separate `style-src-attr` rule; the proxy must stop adding its own
  CSP; the E2E suite must fail on any console CSP violation in every screen, in three browsers.
- **Why not on the demo server:** the work runs on every request, on a 1/8-OCPU VM that already idles near
  Oracle's reclaim threshold (see `docs/deploy/cpu-calibration.md`). A nonce makes every HTML response
  unique, so nothing about the panel can be cached or served statically, now or later. (The panel pages are
  already rendered per request, because the language comes from a cookie / `Accept-Language`; the nonce adds
  the middleware and forbids caching on top.) The risk is a broken hydration or broken charts on the one
  public URL that is the portfolio's front door, to gain 20 points on a scanner for a demo with sample data.
- **Viable on a bigger server:** on a real client's server (more than a fraction of a CPU, a CDN not required)
  the middleware cost is negligible and the nonce policy is the right default. It is on the roadmap below.
- **What already protects the panel without it:** the access token lives only in memory, the refresh cookie is
  `HttpOnly` and `SameSite=Strict`, the panel renders no user-supplied HTML, and the CSP still blocks
  framing, plugins, foreign origins for scripts / images / connections and form posts to other sites.

## Roadmap (security)

- Nonce-based CSP for the panel (A+ on Observatory) on the paid deployment, with the E2E CSP-violation guard.
- MFA (TOTP) for panel users, before a real client.
- Retention for stored webhook payloads and media.
- A separate full security audit before the repository goes public and before v1.0.0.

## Known limits

- No MFA yet (planned before a real client).
- While the repository is private on GitHub Free, `main` is protected by convention: a CI job
  detects direct pushes and a local pre-push hook refuses them. There are no branch rules.
- Retention policies for stored webhook payloads and media are not defined yet.
