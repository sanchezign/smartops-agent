import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMime } from "../../media/media-policy.js";
import type { Transcriber } from "../transcriber.js";
import { audioExtension } from "./openai-compatible.js";

/**
 * Deterministic transcriber for development, tests and demos without an API key.
 * Never allowed in production (env.ts). It accepts the same formats as Groq, and
 * returns the text registered by `wa:simulate audio --transcript "…"` (file
 * `<transcriptsDir>/<sha256 of the audio>.txt`), or a fixed placeholder otherwise.
 */

const GROQ_LIKE = new Set(["flac", "mp3", "m4a", "ogg", "wav", "webm"]);

export function createFakeTranscriber(config: {
  transcriptsDir: string;
  latencyMs?: number;
}): Transcriber {
  return {
    provider: "fake",
    model: "fake-whisper",

    supports(mimeType) {
      const ext = audioExtension(mimeType);
      return ext !== null && GROQ_LIKE.has(ext);
    },

    async transcribe({ bytes, mimeType, language }) {
      if (config.latencyMs) await new Promise((r) => setTimeout(r, config.latencyMs));
      const sha = createHash("sha256").update(bytes).digest("hex");
      const path = join(config.transcriptsDir, `${sha}.txt`);
      const text = existsSync(path)
        ? readFileSync(path, "utf8").trim()
        : `[transcripción simulada: ${normalizeMime(mimeType)}, ${bytes.byteLength} bytes]`;
      return {
        text,
        provider: "fake",
        model: "fake-whisper",
        language: language ?? null,
        durationSeconds: null,
        latencyMs: config.latencyMs ?? 0,
      };
    },
  };
}
