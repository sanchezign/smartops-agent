/**
 * How the panel's media route serves a stored file (phase 9 M3, ADR-019). Pure.
 *
 * The bytes come from WhatsApp contacts: untrusted. Only types a browser renders safely are
 * served inline (images, audio, PDF); everything else (spreadsheets, docx, csv, txt…) as an
 * attachment with application/octet-stream, so it can never be rendered as a page of our
 * origin. The route also sends nosniff and a sandbox CSP.
 */

const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "application/pdf",
]);

export const MEDIA_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
} as const;

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

/** "audio/ogg; codecs=opus" → "audio/ogg". */
export function baseMime(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** Filename safe for a header: no path, no control chars or quotes, max 150 chars. */
export function safeFilename(filename: string | null, mimeType: string, id: string): string {
  const cleaned = (filename ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point (header injection)
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 150);
  if (cleaned) return cleaned;
  const ext = EXTENSION[baseMime(mimeType)];
  return `archivo-${id.slice(0, 8)}${ext ? `.${ext}` : ""}`;
}

export function mediaResponseHeaders(input: {
  id: string;
  mimeType: string;
  filename: string | null;
  size: number;
}): Record<string, string> {
  const mime = baseMime(input.mimeType);
  const inline = INLINE_TYPES.has(mime);
  const name = safeFilename(input.filename, input.mimeType, input.id);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;\\]/g, "_");
  return {
    ...MEDIA_SECURITY_HEADERS,
    "content-type": inline ? mime : "application/octet-stream",
    "content-length": String(input.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
}
