# ADR-008: Media storage in Postgres (bytea) behind a MediaStorage interface

Date: 2026-09-24
Status: accepted

## Decision

Media received over WhatsApp (images, voice notes, PDFs, spreadsheets) is downloaded
by the worker and its bytes are stored in Postgres, in a dedicated table
`media_blobs` (`bytea`, one row per `media_files` row), behind a `MediaStorage`
interface (`put` / `get`) in `apps/api/src/modules/media/media-storage.ts`.

- Own size cap `MEDIA_MAX_BYTES` (default 25 MB) on top of Meta's limits
  (image 5 MB, audio 16 MB, document 100 MB): effective cap = the smaller one.
- Whitelist: jpeg/png/webp images; ogg/opus, mpeg, mp4/m4a, aac, amr audio; pdf,
  xlsx, xls, docx, csv, txt documents (and jpeg/png sent as documents). Video and
  stickers are not downloaded (`skipped`).
- Content is verified before storing: SHA-256 against Meta's value (hex or base64)
  and magic bytes against the mime type (an executable labelled as PDF is rejected).
- The bytea column uses `STORAGE EXTERNAL` (no TOAST compression; these formats are
  already compressed).

## Reason

- No extra infrastructure, account, credentials or SDK. An S3-compatible bucket
  (e.g. Cloudflare R2) would be a stack deviation for an MVP volume.
- One source of truth and one backup: no orphaned files between two systems, and
  media is transactional with its message.
- Expected MVP volume is small: e.g. 50 files/day × ~500 KB ≈ 0.75 GB/month.
  Render Postgres storage is billed at $0.30 per GB per month (≈ $0.23/month more
  per month of traffic at that rate).

## Consequences

- The database (and its backups) grows with media; retention is not defined yet
  (Known issues in CLAUDE.md).
- Each download is buffered in memory: peak ≈ `MEDIA_MAX_BYTES` ×
  `MEDIA_WORKER_CONCURRENCY` per worker (50 MB with the defaults).
- The free Render Postgres (1 GB, expires after 30 days, no backups) is not viable
  for production anyway.
- Moving to a bucket later = add an `S3MediaStorage` implementation, a backfill
  script and a new ADR. Features (transcription, extraction, admin panel) only use
  `MediaStorage`, so they do not change.

## Alternatives considered

- S3-compatible bucket (R2/S3): scales better and supports streaming, but adds a
  vendor, credentials and a consistency problem between DB rows and objects.
  Revisit when media volume or file sizes grow.
