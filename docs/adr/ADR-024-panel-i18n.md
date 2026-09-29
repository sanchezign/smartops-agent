# ADR-024: Panel in English and Spanish with next-intl (no i18n routing)

Date: 2026-09-28
Status: accepted

## Context

Phase 13 turns the project into an English-first portfolio piece that is still delivered to
Spanish-speaking clients. User rules (2026-09-28):

- The panel is English by default with a selector to Spanish. The choice is saved per user in the
  database; at login, the browser language applies until the person chooses one.
- The public demo starts in English (`PANEL_DEFAULT_LOCALE=en`) with a visible selector. Outside
  the demo, a Spanish browser sees the panel (and the login) in Spanish.
- Numbers and dates follow the panel language: en → `$1,850.00` / `Sep 28`, es → `$ 1.850,00` /
  `28 set.`. Reading prices in supplier messages stays es-UY regardless of the panel language.
- Spanish is neutral (no voseo): "tú" in the panel, "usted" in WhatsApp messages.

The common stack has no i18n library.

## Decision

- **next-intl 4** (pinned exactly; listed first in the Next.js App Router i18n guide; peer
  dependencies cover Next 15 and React 19), **without i18n routing**: the URL never carries the
  language. `src/i18n/request.ts` resolves the language per request: cookie `smartops_locale` →
  `PANEL_DEFAULT_LOCALE` (server env) → `Accept-Language` (by q-value) → English. The pure rules
  live in `src/i18n/locales.ts` (unit-tested).
- Messages: `src/i18n/messages/{en,es}.json`, ICU syntax. English is the source catalog and types
  the keys (`AppConfig` in `src/i18n/next-intl.d.ts`). A test requires both catalogs to have the
  same keys, with no empty values.
- The root layout renders `<html lang>` with the resolved language and `NextIntlClientProvider`
  (it inherits the locale, the messages and the time zone from the server). Every page is now
  rendered per request: the language depends on the cookie or the header.
- Per-user preference: `users.locale` (NULL = follow the browser; CHECK `users_locale_chk` en/es),
  returned by login and `GET /api/v1/auth/me`, saved with `PATCH /api/v1/auth/me {locale}`.
  After a login, a saved language that differs from the one shown is written to the cookie and
  applied with a full page load. The shared public demo operator (ADR-021 and phase 12 addendum A)
  cannot save one (403): one visitor must not change the language of the others. The panel keeps
  it in the cookie only.
- Selector: a native `<select>` on the login screen and in the top bar from tablets up, plus a
  radio group in the user menu (phones). Changing it writes the cookie, saves the profile (except
  for the shared account) and reloads the page.
- Formatting: `createFormat(locale)` (`src/lib/format.ts`) and the `useFormat()` hook. en → en-US,
  es → es-UY, always in the business time zone (America/Montevideo). In both languages, `$` means
  the business currency (UYU), USD is `US$` and other currencies show their ISO code, so two
  currencies never share `$`. Percentages and ratios are built by hand (ICU versions disagree on
  the space before `%`).
- Guard (phase 13 M2): `eslint-plugin-i18next` `no-literal-string` on the panel's JSX, so no
  user-visible text bypasses the catalogs.

## Consequences

- Rendering per request costs a little server time on every page load. That is irrelevant for an
  internal panel behind a login.
- The language switch reloads the page. It is simple and correct: server-rendered texts,
  formatters and cached queries all restart in the new language.
- `next-intl` 4 depends on `@swc/core` and `@parcel/watcher` for its optional message extractor.
  Both ship prebuilt native bindings, and their install-time fallbacks are skipped in `allowBuilds`.
- Texts that the API composes (WhatsApp digests, acknowledgements) do not follow the panel
  language. They follow the business-language setting (phase 13 M3).
