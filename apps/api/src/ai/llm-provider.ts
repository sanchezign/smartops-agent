import type { ZodType } from "zod";
import type { BusinessLanguage } from "../common/business-texts.js";

/**
 * Provider-agnostic structured generation (ADR-011). Features never import a provider
 * SDK: they call the AiClient, which calls an LlmProvider (anthropic | fake).
 */

export type LlmProviderName = "anthropic" | "fake";
export type AiTaskName = "classify" | "extract" | "map_columns" | "match";
export type Effort = "low" | "medium" | "high";

/** Content sent to the model. Documents and images are DATA, never instructions. */
export type LlmContent =
  | {
      type: "text";
      text: string;
      /**
       * What the fake provider hashes for golden-output keys instead of `text`: only
       * the message's own content, not trusted context (catalog, sender), so golden
       * outputs survive changes in how that context is rendered.
       */
      fakeKeyText?: string;
      /**
       * Cache breakpoint after this block (trusted, repeated context such as the catalog
       * across the batches of one run). Honored only when the request caches (cacheSystem).
       */
      cache?: boolean;
    }
  | {
      type: "image";
      mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      data: Uint8Array;
    }
  | { type: "pdf"; data: Uint8Array; title?: string };

export interface StructuredRequest<T> {
  task: AiTaskName;
  model: string;
  /** System prompt (versioned file). Cached when `cacheSystem` and long enough. */
  system: string;
  cacheSystem: boolean;
  content: LlmContent[];
  /** JSON Schema sent to the provider (structured outputs; no numeric/length constraints). */
  jsonSchema: Record<string, unknown>;
  /** Authoritative validation of the output (ranges, decimals, ISO codes…). */
  schema: ZodType<T>;
  effort: Effort;
  maxTokens: number;
  /**
   * Business language of the request (phase 14 M5b). Real providers ignore it (the language
   * reaches the model through the system prompt); the FAKE provider's heuristics use it to answer
   * in the language of the business. Absent = "es".
   */
  language?: BusinessLanguage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: TokenUsage;
  model: string;
  latencyMs: number;
  stopReason: string | null;
}

export type LlmErrorKind =
  /** Missing/invalid API key. */
  | "auth"
  | "rate_limited"
  /** Provider overloaded / 5xx. */
  | "unavailable"
  | "timeout"
  /** Output missing, truncated (max_tokens), refused, or not matching the schema. */
  | "invalid_output"
  /** Request rejected by the provider (e.g. unsupported content). */
  | "bad_request";

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    public readonly retryable: boolean,
    message: string,
    /** Tokens billed even though the call failed (e.g. invalid output). */
    public readonly usage?: TokenUsage,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
