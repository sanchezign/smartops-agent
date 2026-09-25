import type { Logger } from "../common/logger.js";
import { checkBudget, startOfUtcDay, type BudgetLimits } from "./budget.js";
import {
  LlmError,
  type AiTaskName,
  type LlmProvider,
  type StructuredRequest,
  type StructuredResult,
  type TokenUsage,
} from "./llm-provider.js";
import { costUsd, estimateInputTokens, estimateMaxCostUsd } from "./pricing.js";
import type { AiUsageRepository, RecordUsageInput } from "./usage.repository.js";

/**
 * The only entry point features use to call an LLM (ADR-011):
 *  1. worst-case cost estimate → budget / per-contact check (blocked calls are recorded)
 *  2. provider call (timeout inside the provider)
 *  3. real cost from the reported usage → ledger row (ok | error), logs WITHOUT content
 * The fake provider costs $0 but still goes through the same path.
 */

export class BudgetExceededError extends Error {
  constructor(
    public readonly reason:
      | "total_budget_exceeded"
      | "daily_budget_exceeded"
      | "run_budget_exceeded"
      | "contact_daily_limit",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface AiCallContext {
  promptVersion: string;
  ingestionRunId?: string;
  messageId?: string;
  contactId?: string;
  log: Logger;
}

export interface AiCallResult<T> extends StructuredResult<T> {
  costUsd: number;
}

export interface AiClient {
  readonly provider: string;
  /** Worst-case cost of one request (input estimate + max_tokens). $0 for the fake provider. */
  estimateUsd<T>(request: StructuredRequest<T>): number;
  /**
   * Checks a whole batch of calls (e.g. every matching batch of one document) against the
   * budgets BEFORE the first one: a batch that cannot finish is refused up front
   * (BudgetExceededError, recorded as budget_blocked) instead of spending half of it.
   */
  preflight(
    input: { task: AiTaskName; model: string; estimatedUsd: number; isExtraction: boolean },
    ctx: AiCallContext,
  ): Promise<void>;
  generateStructured<T>(
    request: StructuredRequest<T>,
    ctx: AiCallContext,
  ): Promise<AiCallResult<T>>;
}

const ZERO: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function createAiClient(deps: {
  provider: LlmProvider;
  usage: AiUsageRepository;
  limits: BudgetLimits;
  now?: () => Date;
}): AiClient {
  const now = deps.now ?? (() => new Date());
  const isFake = deps.provider.name === "fake";
  const cost = (model: string, usage: TokenUsage) => (isFake ? 0 : costUsd(model, usage));

  async function assertWithinBudget(
    call: { task: AiTaskName; model: string; estimatedCostUsd: number; isExtraction: boolean },
    ctx: AiCallContext,
    base: Omit<RecordUsageInput, "status" | "usage" | "costUsd" | "latencyMs">,
  ): Promise<void> {
    const [spentTotalUsd, spentTodayUsd, contactExtractionsToday, spentRunUsd] = await Promise.all([
      deps.usage.spentTotalUsd(),
      deps.usage.spentSinceUsd(startOfUtcDay(now())),
      ctx.contactId && call.isExtraction
        ? deps.usage.extractionsForContactSince(ctx.contactId, startOfUtcDay(now()))
        : Promise.resolve(null),
      ctx.ingestionRunId ? deps.usage.spentForRunUsd(ctx.ingestionRunId) : Promise.resolve(null),
    ]);
    const decision = checkBudget(
      deps.limits,
      { spentTotalUsd, spentTodayUsd, contactExtractionsToday, spentRunUsd },
      { estimatedCostUsd: call.estimatedCostUsd, isExtraction: call.isExtraction },
    );
    if (decision.allowed) return;
    await deps.usage.record({
      ...base,
      status: "budget_blocked",
      usage: ZERO,
      costUsd: 0,
      latencyMs: null,
      reason: decision.reason,
      error: decision.detail,
    });
    ctx.log.error(
      { task: call.task, model: call.model, reason: decision.reason, detail: decision.detail },
      "AI call blocked by budget",
    );
    throw new BudgetExceededError(decision.reason, decision.detail);
  }

  const baseOf = (task: AiTaskName, model: string, ctx: AiCallContext) => ({
    task,
    provider: deps.provider.name,
    model,
    promptVersion: ctx.promptVersion,
    ...(ctx.ingestionRunId ? { ingestionRunId: ctx.ingestionRunId } : {}),
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    ...(ctx.contactId ? { contactId: ctx.contactId } : {}),
  });

  return {
    provider: deps.provider.name,

    estimateUsd(request) {
      if (isFake) return 0;
      return estimateMaxCostUsd(
        request.model,
        estimateInputTokens(request.system, request.content),
        request.maxTokens,
      );
    },

    async preflight(input, ctx) {
      if (isFake) return;
      await assertWithinBudget(
        {
          task: input.task,
          model: input.model,
          estimatedCostUsd: input.estimatedUsd,
          isExtraction: input.isExtraction,
        },
        ctx,
        baseOf(input.task, input.model, ctx),
      );
    },

    async generateStructured(request, ctx) {
      const base = baseOf(request.task, request.model, ctx);

      if (!isFake) {
        const estimatedCostUsd = estimateMaxCostUsd(
          request.model,
          estimateInputTokens(request.system, request.content),
          request.maxTokens,
        );
        await assertWithinBudget(
          {
            task: request.task,
            model: request.model,
            estimatedCostUsd,
            isExtraction: request.task === "extract",
          },
          ctx,
          base,
        );
      }

      const started = now().getTime();
      try {
        const result = await deps.provider.generateStructured(request);
        const callCost = cost(request.model, result.usage);
        await deps.usage.record({
          ...base,
          model: result.model,
          status: "ok",
          usage: result.usage,
          costUsd: callCost,
          latencyMs: result.latencyMs,
        });
        ctx.log.info(
          {
            task: request.task,
            provider: deps.provider.name,
            model: result.model,
            latencyMs: result.latencyMs,
            ...result.usage,
            costUsd: Number(callCost.toFixed(6)),
            stopReason: result.stopReason,
          },
          "AI call completed",
        );
        return { ...result, costUsd: callCost };
      } catch (err) {
        const usage = err instanceof LlmError && err.usage ? err.usage : ZERO;
        const callCost = cost(request.model, usage);
        await deps.usage.record({
          ...base,
          status: "error",
          usage,
          costUsd: callCost,
          latencyMs: now().getTime() - started,
          reason: err instanceof LlmError ? err.kind : "unexpected",
          error: err instanceof Error ? err.message : String(err),
        });
        ctx.log.warn(
          {
            task: request.task,
            model: request.model,
            kind: err instanceof LlmError ? err.kind : "unexpected",
            costUsd: Number(callCost.toFixed(6)),
          },
          "AI call failed",
        );
        throw err;
      }
    },
  };
}
