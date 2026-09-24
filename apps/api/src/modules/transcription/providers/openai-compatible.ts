import { normalizeMime } from "../../media/media-policy.js";
import {
  TranscriptionError,
  type Transcriber,
  type TranscriptionProviderName,
} from "../transcriber.js";

/**
 * Whisper-compatible transcription over the OpenAI audio API shape
 * (POST {baseUrl}/audio/transcriptions, multipart). Works for Groq
 * (https://api.groq.com/openai/v1) and OpenAI (https://api.openai.com/v1).
 * Native fetch/FormData/Blob: no SDK.
 */

/**
 * Formats each provider accepts as-is (documented lists, verified 2026-09):
 * Groq: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. OpenAI: same WITHOUT ogg.
 * WhatsApp voice notes are audio/ogg (opus); aac/amr are not accepted by either.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

const SUPPORTED_EXTENSIONS: Record<"groq" | "openai", ReadonlySet<string>> = {
  groq: new Set(["flac", "mp3", "m4a", "ogg", "wav", "webm"]),
  openai: new Set(["mp3", "m4a", "wav", "webm"]),
};

export function audioExtension(mimeType: string): string | null {
  return EXTENSION_BY_MIME[normalizeMime(mimeType)] ?? null;
}

export function createOpenAiCompatibleTranscriber(config: {
  provider: "groq" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  now?: () => number;
}): Transcriber {
  const now = config.now ?? (() => Date.now());
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  // verbose_json (duration + language) is supported by Whisper models; the gpt-4o
  // transcribe models only return json.
  const verbose = config.model.startsWith("whisper");

  return {
    provider: config.provider,
    model: config.model,

    supports(mimeType) {
      const ext = audioExtension(mimeType);
      return ext !== null && SUPPORTED_EXTENSIONS[config.provider].has(ext);
    },

    async transcribe({ bytes, mimeType, language, prompt }) {
      const ext = audioExtension(mimeType);
      if (!ext || !SUPPORTED_EXTENSIONS[config.provider].has(ext)) {
        throw new TranscriptionError(
          "invalid_audio",
          false,
          `${config.provider} does not accept ${normalizeMime(mimeType) || "unknown"} audio`,
        );
      }

      const form = new FormData();
      // Providers infer the format from the file name extension.
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: normalizeMime(mimeType) }),
        `audio.${ext}`,
      );
      form.append("model", config.model);
      form.append("response_format", verbose ? "verbose_json" : "json");
      form.append("temperature", "0");
      if (language) form.append("language", language);
      if (prompt) form.append("prompt", prompt);

      const started = now();
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new TranscriptionError(
            "timeout",
            true,
            `Transcription timed out after ${config.timeoutMs} ms`,
            undefined,
            undefined,
            { cause: err },
          );
        }
        throw new TranscriptionError(
          "transient",
          true,
          `Transcription request failed: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          undefined,
          { cause: err },
        );
      }

      const bodyText = await response.text();
      if (!response.ok) {
        throw classifyHttpError(response.status, bodyText, response.headers.get("retry-after"));
      }

      let body: { text?: unknown; language?: unknown; duration?: unknown };
      try {
        body = JSON.parse(bodyText) as typeof body;
      } catch {
        throw new TranscriptionError(
          "transient",
          true,
          "Transcription response is not JSON",
          response.status,
        );
      }
      if (typeof body.text !== "string") {
        throw new TranscriptionError(
          "transient",
          true,
          "Transcription response without text",
          response.status,
        );
      }
      const duration = typeof body.duration === "number" ? body.duration : Number(body.duration);
      return {
        text: body.text.trim(),
        provider: config.provider,
        model: config.model,
        language: typeof body.language === "string" ? body.language : null,
        durationSeconds: Number.isFinite(duration) ? duration : null,
        latencyMs: now() - started,
      };
    },
  };
}

/** HTTP status → error kind (pure, unit tested). The response body is never logged. */
export function classifyHttpError(
  status: number,
  body: string,
  retryAfter: string | null,
): TranscriptionError {
  let message = `Transcription failed with HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") {
      message = `${message}: ${parsed.error.message.slice(0, 300)}`;
    }
  } catch {
    // non-JSON error body: keep the generic message
  }
  if (status === 401 || status === 403) {
    return new TranscriptionError("unauthorized", true, message, status);
  }
  if (status === 429) {
    const seconds = retryAfter === null ? undefined : Number(retryAfter);
    return new TranscriptionError(
      "rate_limited",
      true,
      message,
      status,
      seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined,
    );
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return new TranscriptionError("invalid_audio", false, message, status);
  }
  return new TranscriptionError("transient", true, message, status);
}

export const DEFAULT_TRANSCRIPTION_CONFIG: Record<
  Exclude<TranscriptionProviderName, "fake">,
  { baseUrl: string; model: string }
> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
};
