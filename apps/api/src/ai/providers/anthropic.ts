import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  LlmError,
  type LlmContent,
  type LlmProvider,
  type StructuredRequest,
  type TokenUsage,
} from "../llm-provider.js";
import { modelPrice } from "../pricing.js";

/**
 * Claude API provider (ADR-011): structured outputs via `output_config.format`
 * (json_schema, GA), explicit `output_config.effort` (thinking tokens are billed as
 * output), prompt caching on the system prompt, documents/images as base64 blocks.
 * The Zod schema is re-applied to the output: structured outputs guarantee JSON shape,
 * not business ranges (no minimum/maximum/length in the JSON schema).
 */
export function createAnthropicProvider(config: {
  apiKey: string;
  timeoutMs: number;
  /** SDK retries on 408/409/429/5xx. Kept at 1: retries multiply the cost. */
  maxRetries?: number;
  /** Test seam: inject a fetch implementation. */
  fetch?: typeof fetch;
  now?: () => number;
}): LlmProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries ?? 1,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const now = config.now ?? (() => Date.now());

  return {
    name: "anthropic",

    async generateStructured<T>(request: StructuredRequest<T>) {
      const started = now();
      let response: Anthropic.Messages.Message;
      try {
        response = await client.messages.create(buildAnthropicMessageParams(request));
      } catch (err) {
        throw mapError(err);
      }
      const latencyMs = now() - started;

      const usage: TokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      };

      if (response.stop_reason === "refusal") {
        throw new LlmError("invalid_output", false, "model refused to answer", usage);
      }
      if (response.stop_reason === "max_tokens") {
        throw new LlmError(
          "invalid_output",
          false,
          `output truncated at max_tokens=${request.maxTokens}`,
          usage,
        );
      }
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError("invalid_output", false, "structured output is not valid JSON", usage);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new LlmError("invalid_output", false, `output failed validation: ${issues}`, usage);
      }
      return {
        data: parsed.data,
        usage,
        model: response.model,
        latencyMs,
        stopReason: response.stop_reason,
      };
    },
  };
}

function toBlock(block: LlmContent, cache: boolean): ContentBlockParam {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(cache && block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType,
          data: Buffer.from(block.data).toString("base64"),
        },
      };
    case "pdf":
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from(block.data).toString("base64"),
        },
        ...(block.title ? { title: block.title } : {}),
      };
  }
}

/**
 * The exact Messages API parameters for a structured request. Shared by the provider
 * and the golden-recording script (which also sends them to the free count_tokens
 * endpoint to price a run before spending).
 */
export function buildAnthropicMessageParams<T>(request: StructuredRequest<T>) {
  // Cache only when the system prompt can be cached (min 1,024 tokens on Sonnet 5,
  // 4,096 on Haiku 4.5); below that cache_control would be ignored anyway.
  const cacheable =
    request.cacheSystem &&
    Math.ceil(request.system.length / 3.5) >= modelPrice(request.model).minCacheableTokens;
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: "text" as const,
        text: request.system,
        ...(cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ],
    messages: [
      {
        role: "user" as const,
        content: request.content.map((block) => toBlock(block, request.cacheSystem)),
      },
    ],
    output_config: {
      effort: request.effort,
      format: { type: "json_schema" as const, schema: request.jsonSchema },
    },
  };
}

function mapError(err: unknown): LlmError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof APIConnectionTimeoutError)
    return new LlmError("timeout", true, message, undefined, { cause: err });
  if (err instanceof APIConnectionError)
    return new LlmError("unavailable", true, message, undefined, { cause: err });
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new LlmError("auth", false, message, undefined, { cause: err });
  }
  if (err instanceof RateLimitError)
    return new LlmError("rate_limited", true, message, undefined, { cause: err });
  if (err instanceof BadRequestError)
    return new LlmError("bad_request", false, message, undefined, { cause: err });
  if (err instanceof APIError) {
    // 529 overloaded and other 5xx.
    const status = err.status ?? 0;
    return new LlmError(
      status >= 500 ? "unavailable" : "bad_request",
      status >= 500,
      message,
      undefined,
      { cause: err },
    );
  }
  return new LlmError("unavailable", true, message, undefined, { cause: err });
}
