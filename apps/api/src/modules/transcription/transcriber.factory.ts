import { readFileSync } from "node:fs";
import type { Env } from "../../config/env.js";
import { createFakeTranscriber } from "./providers/fake.js";
import {
  createOpenAiCompatibleTranscriber,
  DEFAULT_TRANSCRIPTION_CONFIG,
} from "./providers/openai-compatible.js";
import type { Transcriber } from "./transcriber.js";

/** Whisper prompts are limited to 224 tokens; stay well below (~4 chars per token). */
export const MAX_PROMPT_CHARS = 800;

const VOCABULARY_PROMPT_URL = new URL("./prompts/vocabulary.md", import.meta.url);

/** Versioned vocabulary prompt (copied to dist by scripts/copy-assets.mjs). */
export function loadVocabularyPrompt(url: URL = VOCABULARY_PROMPT_URL): string {
  const text = readFileSync(url, "utf8").replace(/\s+/g, " ").trim();
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `transcription vocabulary prompt is ${text.length} chars (max ${MAX_PROMPT_CHARS}): Whisper keeps only 224 tokens`,
    );
  }
  return text;
}

export function createTranscriber(
  env: Pick<
    Env,
    | "TRANSCRIPTION_PROVIDER"
    | "TRANSCRIPTION_API_KEY"
    | "TRANSCRIPTION_BASE_URL"
    | "TRANSCRIPTION_MODEL"
    | "TRANSCRIPTION_TIMEOUT_MS"
    | "TRANSCRIPTION_FAKE_DIR"
  >,
): Transcriber {
  if (env.TRANSCRIPTION_PROVIDER === "fake") {
    return createFakeTranscriber({ transcriptsDir: env.TRANSCRIPTION_FAKE_DIR });
  }
  const defaults = DEFAULT_TRANSCRIPTION_CONFIG[env.TRANSCRIPTION_PROVIDER];
  if (!env.TRANSCRIPTION_API_KEY) {
    // env.ts already enforces this; kept for type narrowing and direct callers.
    throw new Error(`TRANSCRIPTION_API_KEY is required for ${env.TRANSCRIPTION_PROVIDER}`);
  }
  return createOpenAiCompatibleTranscriber({
    provider: env.TRANSCRIPTION_PROVIDER,
    baseUrl: env.TRANSCRIPTION_BASE_URL ?? defaults.baseUrl,
    apiKey: env.TRANSCRIPTION_API_KEY,
    model: env.TRANSCRIPTION_MODEL ?? defaults.model,
    timeoutMs: env.TRANSCRIPTION_TIMEOUT_MS,
  });
}
