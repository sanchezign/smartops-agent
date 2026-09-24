/**
 * Speech-to-text behind a provider-agnostic interface (ADR-005, ADR-010). Features only
 * depend on `Transcriber`; the provider is chosen by configuration.
 */

export type TranscriptionProviderName = "groq" | "openai" | "fake";

export interface TranscribeInput {
  bytes: Uint8Array;
  mimeType: string;
  /** ISO-639-1 language hint (e.g. "es"). */
  language?: string;
  /** Vocabulary / style hint (Whisper prompt, ≤ 224 tokens). */
  prompt?: string;
}

export interface TranscriptionResult {
  text: string;
  provider: TranscriptionProviderName;
  model: string;
  /** Detected language, when the provider reports it. */
  language: string | null;
  /** Audio duration in seconds (what providers bill), when reported. */
  durationSeconds: number | null;
  latencyMs: number;
}

export type TranscriptionErrorKind =
  /** File rejected by the provider (format, corrupt, too large). Permanent. */
  | "invalid_audio"
  /** Missing/invalid API key. Retryable after fixing the key. */
  | "unauthorized"
  /** Provider rate limit (Groq free plan: 20 req/min, audio seconds/hour/day). */
  | "rate_limited"
  | "timeout"
  | "transient";

export class TranscriptionError extends Error {
  constructor(
    public readonly kind: TranscriptionErrorKind,
    public readonly retryable: boolean,
    message: string,
    public readonly httpStatus?: number,
    /** Seconds suggested by the provider (`retry-after`), for rate limits. */
    public readonly retryAfterSeconds?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

export interface Transcriber {
  readonly provider: TranscriptionProviderName;
  readonly model: string;
  /** True when the provider accepts this audio mime type as-is (no transcoding). */
  supports(mimeType: string): boolean;
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}
