import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LlmError,
  type AiTaskName,
  type LlmContent,
  type LlmProvider,
  type StructuredRequest,
} from "../llm-provider.js";

/**
 * Deterministic LLM for development, tests, CI and a demo without a key (ADR-011).
 * Never allowed in production (env.ts). Resolution order:
 *  1. golden output recorded from a real run: <goldenDir>/<task>/<contentKey>.json
 *  2. a responder for the task (heuristics, set by the classification/extraction modules)
 *  3. otherwise an invalid_output error (like a model that cannot answer)
 * The output goes through the same Zod schema as real responses. Cost is always $0.
 */

export type FakeResponder = (request: StructuredRequest<unknown>) => unknown;

/** Stable key of the request content (text and bytes), independent of the prompt. */
export function fakeContentKey(task: AiTaskName, content: LlmContent[]): string {
  const hash = createHash("sha256").update(task);
  for (const block of content) {
    hash.update(`\u0000${block.type}\u0000`);
    hash.update(block.type === "text" ? block.text : block.data);
  }
  return hash.digest("hex");
}

export function createFakeLlmProvider(
  config: {
    goldenDir?: string;
    responders?: Partial<Record<AiTaskName, FakeResponder>>;
    latencyMs?: number;
  } = {},
): LlmProvider {
  return {
    name: "fake",

    async generateStructured<T>(request: StructuredRequest<T>) {
      if (config.latencyMs) await new Promise((r) => setTimeout(r, config.latencyMs));
      const key = fakeContentKey(request.task, request.content);
      const golden = config.goldenDir ? join(config.goldenDir, request.task, `${key}.json`) : null;

      let output: unknown;
      if (golden && existsSync(golden)) {
        output = JSON.parse(readFileSync(golden, "utf8"));
      } else if (config.responders?.[request.task]) {
        output = config.responders[request.task]?.(request as StructuredRequest<unknown>);
      } else {
        throw new LlmError(
          "invalid_output",
          false,
          `fake LLM: no golden output (${request.task}/${key.slice(0, 12)}…) and no responder`,
        );
      }

      const parsed = request.schema.safeParse(output);
      if (!parsed.success) {
        throw new LlmError(
          "invalid_output",
          false,
          `fake LLM output failed validation: ${parsed.error.message}`,
        );
      }
      return {
        data: parsed.data,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: request.model,
        latencyMs: config.latencyMs ?? 0,
        stopReason: "end_turn",
      };
    },
  };
}
