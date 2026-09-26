# ADR-018: Panel authentication — rotating refresh sessions, Argon2id, same-origin deploy

Date: 2026-09-27
Status: accepted

## Decision

### Tokens

- **Access token:** JWT HS256 signed with `jose`, 15 min (`ACCESS_TOKEN_TTL_SECONDS`),
  claims `sub`, `role`, `sid`, fixed `iss`/`aud`. The panel keeps it **in memory only**
  (never localStorage) and sends it as `Authorization: Bearer`. The API re-reads the session
  and the user on **every** request (`AuthService.authenticate`), so logout-all, a role
  change or a deactivation take effect immediately; the `role` claim is informational.
- **Refresh token:** opaque 256-bit random value (`base64url`). Only its SHA-256 is stored
  (`refresh_tokens.token_hash`), linked to a session (`auth_sessions`). It travels in an
  `HttpOnly` cookie with `Path=/api/v1/auth`, so no other request carries it.
- **Rotation (RFC 9700):** every `POST /auth/refresh` marks the token rotated and issues a
  new one in the same session. Presenting an already-rotated token revokes the whole
  session (`auth.refresh_reuse_detected`). Grace: the token rotated **just now** (≤ 10 s,
  the most recent one) returns `409 REFRESH_RACE` without revoking — two tabs refreshing
  with the same cookie at the same time. The token row is locked (`SELECT … FOR UPDATE`),
  so concurrent refreshes are serialized; the panel also serializes refreshes across tabs
  with the Web Locks API.
- **Session lifetime:** 24 h without a refresh (`SESSION_IDLE_HOURS`) or 7 days in total
  (`SESSION_MAX_DAYS`), whichever comes first.

### CSRF

Only `login`, `refresh` and `logout` use the cookie; everything else uses the Bearer token,
which a browser never attaches on its own. On the cookie routes (OWASP CSRF cheat sheet):

1. a custom header `X-SmartOps-CSRF: 1` is required (cross-origin pages cannot send it
   without a preflight the CORS allowlist refuses);
2. `Origin` must be the API's own origin or listed in `CORS_ORIGINS`;
3. in same-origin / same-site modes, `Sec-Fetch-Site: cross-site` is rejected;
4. `SameSite` on the cookie (below) as defense in depth.

### Passwords

- **Argon2id** with Node's built-in `crypto.argon2` (added in 24.7, stable since 24.19 →
  `engines >= 24.19`; the API refuses to start without it). OWASP Password Storage minimum:
  19 MiB memory, 2 passes, parallelism 1, 16-byte salt, 32-byte tag. PHC string storage; a
  hash with weaker parameters is re-hashed on the next successful login.
- **Policy** (OWASP Authentication cheat sheet / NIST SP 800-63B): 15–128 characters (no MFA
  yet), no composition rules, any Unicode (NFKC-normalized), rejected: a common/breached
  offline list (SecLists NCSC top 100k, entries ≥ 15 chars, stored as SHA-256), trivial
  patterns, and the user's email, name or the product name. HIBP k-anonymity is documented
  as an option for a client, not used in the demo.
- **Lockout:** 5 failures within 15 min lock the account for 15 min; consecutive locks double
  the duration, **capped at 1 h**; a success resets it. Plus a per-IP limit on `/auth/login`
  (`LOGIN_RATE_LIMIT_MAX` per 15 min). Every failure returns the **same** 401 message, with the
  same Argon2 work (a dummy hash for unknown emails) — no enumeration by message or timing.

### Users and roles

- **First admin only from the server:** `pnpm --filter @smartops/api users create … --role admin`.
  The password is typed twice at a hidden prompt or read from stdin — never a command-line
  argument, never a default, no HTTP bootstrap endpoint.
- Roles `admin` and `operator` (the permission matrix is enforced in phase 8 M4). The last
  active admin can never be demoted or deactivated (advisory lock `users:admins`). A role
  change, a deactivation or a password reset revokes every session of that user.
- **Audit:** `auth.login_succeeded`, `auth.login_failed` (reason; unknown emails masked),
  `auth.account_locked`, `auth.refresh_reuse_detected`, `auth.logout`, `auth.logout_all`,
  `user.created`, `user.role_changed`, `user.deactivated`, `user.reactivated`,
  `user.password_reset`, `user.unlocked`. Never passwords or tokens.

### Deploy modes (cookie attributes by env)

| Mode                      | Where                                                     | Cookie                               | Notes                                                                                                   |
| ------------------------- | --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **D (demo, recommended)** | Oracle VM behind Caddy: `/` → Next.js panel, `/api` → API | `SameSite=Strict`, Secure            | Real same origin, SSE direct, real client IP, $0 (free subdomain + Caddy HTTPS)                         |
| A                         | Vercel rewrite `/api/*` → API                             | `SameSite=Strict`, Secure            | If phase 12 ends on Render (plan B). Disable rewrite caching; SSE/timeouts through the proxy to confirm |
| B                         | Own domain, `panel.x.com` + `api.x.com`                   | `SameSite=Lax`, Secure               | For a real client (a domain costs money — ask first)                                                    |
| C                         | Cross-site (`*.vercel.app` ↔ another domain)              | `SameSite=None; Secure; Partitioned` | Supported, fragile: Safari blocks third-party cookies (CHIPS since 18.4)                                |

`AUTH_COOKIE_SAMESITE`, `AUTH_COOKIE_SECURE` (`auto` = Secure in production) and
`AUTH_COOKIE_PARTITIONED` select the mode; `None`/`Partitioned` require Secure. The cookie
is named `__Secure-smartops_rt` when Secure (the browser rejects it over plain HTTP).

## Reason

- Short access tokens in memory + a rotating HttpOnly refresh cookie is the standard
  browser pattern: XSS cannot read the refresh token, a stolen refresh token is detected on
  its next use, and nothing long-lived sits in JavaScript-readable storage.
- Re-reading the session on each request costs one indexed query at our scale and gives
  instant revocation without a token blacklist.
- Built-in Argon2id avoids a native dependency (no `allowBuilds`, no prebuilt binaries).
- Same origin (mode D) removes cross-site cookie problems entirely and costs $0 on the VM.

## Consequences

- New env vars (`.env.example`): `JWT_ACCESS_SECRET` (required), TTLs, cookie mode,
  `LOGIN_RATE_LIMIT_MAX`. Rotating `JWT_ACCESS_SECRET` invalidates access tokens only (the
  panel refreshes silently).
- Migrations `user_lockout`, `auth_sessions`. Sessions and tokens are never deleted by the
  app (revoked instead); a retention cleanup can come with the other retention jobs.
- **MFA (TOTP) is the recommended next step before a real client** (user, 2026-09-27); with
  MFA the password minimum could drop to 8 per OWASP.
- Admin routes (`/api/v1/admin/*`) and the permission matrix: phase 8 M4. Minimal login page:
  phase 8 M5.
