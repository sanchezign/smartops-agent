import type { Env } from "../config/env.js";
import type { LlmProvider } from "./llm-provider.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createFakeLlmProvider, type FakeResponder } from "./providers/fake.js";
import type { AiTaskName } from "./llm-provider.js";
import { isPricedModel } from "./pricing.js";

type AiEnv = Pick<
  Env,
  | "AI_PROVIDER"
  | "ANTHROPIC_API_KEY"
  | "AI_TIMEOUT_MS"
  | "AI_CLASSIFIER_MODEL"
  | "AI_EXTRACTOR_MODEL"
  | "AI_FAKE_GOLDEN_DIR"
>;

/** Fails fast when a configured model has no verified price (costs must never be 0 by mistake). */
export function assertPricedModels(env: AiEnv): void {
  for (const model of [env.AI_CLASSIFIER_MODEL, env.AI_EXTRACTOR_MODEL]) {
    if (!isPricedModel(model)) {
      throw new Error(`AI model "${model}" has no verified price in src/ai/pricing.ts`);
    }
  }
}

export function createLlmProvider(
  env: AiEnv,
  fakeResponders: Partial<Record<AiTaskName, FakeResponder>> = {},
): LlmProvider {
  assertPricedModels(env);
  if (env.AI_PROVIDER === "fake") {
    return createFakeLlmProvider({ goldenDir: env.AI_FAKE_GOLDEN_DIR, responders: fakeResponders });
  }
  if (!env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, timeoutMs: env.AI_TIMEOUT_MS });
}
