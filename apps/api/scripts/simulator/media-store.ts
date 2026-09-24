import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeMediaId } from "./ids.js";

/**
 * Tiny file-based media store shared by `wa:simulate` (registers a file and puts its
 * media id in the webhook) and `wa:fake-graph` (serves it like Meta's media API).
 * Default location: apps/api/.sim/media (gitignored).
 */

export interface StoredMediaMeta {
  id: string;
  mimeType: string;
  /** Hex SHA-256 of the bytes. */
  sha256Hex: string;
  size: number;
  filename: string | null;
  createdAt: string;
}

export const DEFAULT_SIM_MEDIA_DIR = new URL("../../.sim/media/", import.meta.url);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ogg": "audio/ogg; codecs=opus",
  ".opus": "audio/ogg; codecs=opus",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".mp4": "video/mp4",
  ".3gp": "video/3gpp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".txt": "text/plain",
};

export function mimeFromFilename(filename: string): string | null {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? null;
}

/** WhatsApp message type for a mime type (what a phone would send). */
export function messageTypeForMime(mimeType: string): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/") && mimeType !== "image/webp") return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export function createMediaStore(dir: string | URL = DEFAULT_SIM_MEDIA_DIR) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  mkdirSync(base, { recursive: true });
  const path = (name: string) => join(base, name);

  return {
    register(
      bytes: Uint8Array,
      input: { mimeType: string; filename?: string | null },
    ): StoredMediaMeta {
      const meta: StoredMediaMeta = {
        id: fakeMediaId(),
        mimeType: input.mimeType,
        sha256Hex: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        filename: input.filename ?? null,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(path(`${meta.id}.bin`), bytes);
      writeFileSync(path(`${meta.id}.json`), JSON.stringify(meta, null, 2));
      return meta;
    },

    get(id: string): { meta: StoredMediaMeta; bytes: Buffer } | null {
      if (!/^\d+$/.test(id)) return null;
      const metaPath = path(`${id}.json`);
      if (!existsSync(metaPath)) return null;
      return {
        meta: JSON.parse(readFileSync(metaPath, "utf8")) as StoredMediaMeta,
        bytes: readFileSync(path(`${id}.bin`)),
      };
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;

/** Formats a hex SHA-256 as Meta may send it (hex or base64 — see ADR-008 notes). */
export function formatSha256(hex: string, format: "hex" | "base64"): string {
  return format === "hex" ? hex : Buffer.from(hex, "hex").toString("base64");
}
