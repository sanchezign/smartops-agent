# ADR-019: Chat media in the panel — fetched with the Bearer, shown from blob: URLs

Date: 2026-09-27
Status: accepted

## Context

The conversations screen (phase 9 M3) shows photos, voice notes, PDFs and spreadsheets that
contacts sent over WhatsApp. The bytes live in `media_blobs` (ADR-008). The panel's access
token lives only in memory and travels as `Authorization: Bearer` (ADR-018). An `<img>`,
`<audio>` or a plain link cannot send that header. Two options were compared:

| | A. `fetch` with the Bearer → `Blob` → `blob:` URL | B. Short-lived signed URL (`?sig=…&exp=…`) |
|---|---|---|
| Credentials in URLs | none | a bearer-equivalent in the URL: request logs, browser history, `Referer`, screenshots, shared links; needs extra redaction |
| Revocation | immediate (same Bearer check as every call: logout-all, deactivation, role change) | only when it expires, unless every request re-checks the session tied to the signature |
| New secret / code | none | signing key, expiry, binding to user + session + media id, clock skew |
| Streaming / `Range` | no: the whole file is downloaded before playing | yes, native |
| Browser cache | no (every view fetches again; `no-store`) | possible |
| Memory | the file is held in memory while shown (revoked on unmount) | none |

Our media are small by construction: WhatsApp limits plus `MEDIA_MAX_BYTES`, voice notes of
a few hundred KB, and voice notes over 3 minutes are not auto-transcribed (phase 6). The
panel is used by a handful of people, not the public.

## Decision

**Option A.**

- API: `GET /api/v1/admin/media/:id` (operator and admin, like the chat). It is in the route
  table like every other panel route, so the route-inventory test covers it. Only
  `status = stored` media answers; anything else answers 404 without reading storage.
  Headers (`media-response.ts`, pure and unit-tested):
  - `Content-Type` = the stored MIME, which was **sniffed from magic bytes** at download
    (ADR-008). The route serves it `inline` ONLY for images (jpeg/png/webp), audio
    (ogg/mpeg/mp4/aac/amr) and PDF. Everything else (xlsx, docx, csv, txt, any other type) is
    served as `application/octet-stream` + `attachment`, so contact-supplied content can never
    render as a page of our origin.
  - Always `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none';
    sandbox`, `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`.
  - The filename is sanitized: no path, no control characters or quotes (no header
    injection), ASCII `filename` plus UTF-8 `filename*`.
- Panel: `useMediaBlob` fetches through the same authenticated client (one refresh on a 401,
  like any call), keeps the `Blob` in TanStack Query and creates and revokes the `blob:` URL
  per component. Downloads are **on demand**:
  - images when they scroll into view;
  - audio and documents when the person taps them.

  Voice notes always show the transcript next to the player. A download button is the
  fallback where the browser cannot play the format (Ogg/Opus plays on iOS 18.4+/Safari 18.4
  per WebKit's release notes, with reports of incomplete support). Documents open or download
  from the `blob:` URL with their filename.
- Tests: unit tests (headers, inline vs attachment, filename injection); e2e tests of the
  route (Bearer required, a `?token=` query does nothing, 404 for not stored, bytes intact);
  a browser E2E test that shows a chat photo.

## Consequences

- No token is ever written into a URL; revoking a session cuts media access immediately.
- There is no streaming or seeking before the whole file arrives. That is acceptable for
  WhatsApp-sized media. If large files appear (e.g. real clients sending long videos), revisit
  with option B, binding the signature to the session id and re-checking it on every request.
- Each view downloads the file again (`no-store`). Blobs stay cached in memory for the
  query's `gcTime`, so reopening a chat is instant.
