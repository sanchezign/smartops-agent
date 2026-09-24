/**
 * Media policy (pure): what we download, size limits, and content sniffing.
 * See ADR-008. Meta limits: developers.facebook.com/documentation/business-messaging/
 * whatsapp/business-phone-numbers/media (image 5 MB, audio 16 MB, document 100 MB).
 */

export type MediaKind = "image" | "audio" | "document";

export type RejectReason =
  "unsupported_mime" | "too_large" | "content_mismatch" | "empty_file" | "type_not_downloaded";

const MB = 1024 * 1024;

/** Meta's per-type maximum sizes. */
export const META_MAX_BYTES: Record<MediaKind, number> = {
  image: 5 * MB,
  audio: 16 * MB,
  document: 100 * MB,
};

type Sniffer = (bytes: Uint8Array) => boolean;

const startsWith =
  (...signature: number[]): Sniffer =>
  (bytes) =>
    bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

const ascii = (text: string, offset = 0): Sniffer => {
  const codes = [...text].map((c) => c.charCodeAt(0));
  return (bytes) =>
    bytes.length >= offset + codes.length && codes.every((c, i) => bytes[offset + i] === c);
};

const isJpeg = startsWith(0xff, 0xd8, 0xff);
const isPng = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const isWebp: Sniffer = (b) => ascii("RIFF")(b) && ascii("WEBP", 8)(b);
const isPdf = ascii("%PDF-");
const isOgg = ascii("OggS");
/** MP3: ID3 tag or MPEG audio frame sync. */
const isMp3: Sniffer = (b) =>
  ascii("ID3")(b) || (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);
/** ISO base media (mp4 / m4a / 3gp): "ftyp" box at offset 4. */
const isIsoMedia = ascii("ftyp", 4);
/** AAC: ADTS frame header or ADIF. */
const isAac: Sniffer = (b) =>
  ascii("ADIF")(b) || (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0);
const isAmr = ascii("#!AMR");
/** ZIP container (xlsx, docx). */
const isZip = startsWith(0x50, 0x4b, 0x03, 0x04);
/** OLE2 compound file (legacy xls). */
const isOle2 = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
/** Plain text: no NUL bytes in the first 8 KB. */
const isText: Sniffer = (b) => !b.subarray(0, 8192).includes(0);

interface MimeRule {
  kinds: MediaKind[];
  sniff: Sniffer;
}

/** Allowed mime types (normalized: lowercase, without parameters). */
const MIME_RULES: Record<string, MimeRule> = {
  "image/jpeg": { kinds: ["image", "document"], sniff: isJpeg },
  "image/png": { kinds: ["image", "document"], sniff: isPng },
  "image/webp": { kinds: ["image"], sniff: isWebp },
  "audio/ogg": { kinds: ["audio"], sniff: isOgg },
  "audio/opus": { kinds: ["audio"], sniff: isOgg },
  "audio/mpeg": { kinds: ["audio"], sniff: isMp3 },
  "audio/mp4": { kinds: ["audio"], sniff: isIsoMedia },
  "audio/aac": { kinds: ["audio"], sniff: isAac },
  "audio/amr": { kinds: ["audio"], sniff: isAmr },
  "application/pdf": { kinds: ["document"], sniff: isPdf },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kinds: ["document"],
    sniff: isZip,
  },
  "application/vnd.ms-excel": { kinds: ["document"], sniff: isOle2 },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kinds: ["document"],
    sniff: isZip,
  },
  "text/csv": { kinds: ["document"], sniff: isText },
  "text/plain": { kinds: ["document"], sniff: isText },
};

/** "Audio/OGG; codecs=opus" → "audio/ogg". */
export function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export type MediaPlan =
  | { action: "download"; kind: MediaKind }
  | { action: "skip"; reason: "type_not_downloaded" }
  | { action: "reject"; reason: "unsupported_mime" };

/**
 * Decides, from the WhatsApp message type and mime type, whether a media file is
 * downloaded. Video and stickers are not downloaded (Claude takes no video; stickers
 * carry no business data).
 */
export function planMedia(messageType: string, mimeType: string | null | undefined): MediaPlan {
  if (messageType === "video" || messageType === "sticker") {
    return { action: "skip", reason: "type_not_downloaded" };
  }
  if (messageType !== "image" && messageType !== "audio" && messageType !== "document") {
    return { action: "skip", reason: "type_not_downloaded" };
  }
  const rule = MIME_RULES[normalizeMime(mimeType)];
  if (!rule || !rule.kinds.includes(messageType)) {
    return { action: "reject", reason: "unsupported_mime" };
  }
  return { action: "download", kind: messageType };
}

/** Effective cap: the smaller of Meta's per-type limit and our MEDIA_MAX_BYTES. */
export function effectiveMaxBytes(kind: MediaKind, configuredMaxBytes: number): number {
  return Math.min(META_MAX_BYTES[kind], configuredMaxBytes);
}

/** True when the bytes look like the declared mime type (magic bytes). */
export function contentMatchesMime(mimeType: string, bytes: Uint8Array): boolean {
  const rule = MIME_RULES[normalizeMime(mimeType)];
  return rule !== undefined && rule.sniff(bytes);
}

/**
 * Compares Meta's declared SHA-256 (hex or base64, format not documented) with our
 * hex digest. A missing declared value is accepted (nothing to compare).
 */
export function sha256Matches(declared: string | null | undefined, actualHex: string): boolean {
  if (!declared) return true;
  const value = declared.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase() === actualHex;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("hex") === actualHex;
  } catch {
    return false;
  }
}
