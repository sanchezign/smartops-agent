import type { PrismaClient } from "../common/db.js";
import type { AiTask, AiUsageStatus } from "../generated/prisma/enums.js";
import type { TokenUsage } from "./llm-provider.js";

/** AI usage ledger (ai_usages). The only place in the AI module that touches Prisma. */

export interface RecordUsageInput {
  task: AiTask;
  status: AiUsageStatus;
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number | null;
  promptVersion: string | null;
  reason?: string;
  error?: string;
  ingestionRunId?: string;
  messageId?: string;
  contactId?: string;
}

export interface AiUsageRepository {
  record(input: RecordUsageInput): Promise<void>;
  spentTotalUsd(): Promise<number>;
  spentSinceUsd(since: Date): Promise<number>;
  /** Successful extraction calls for a contact since `since`. */
  extractionsForContactSince(contactId: string, since: Date): Promise<number>;
}

export function createAiUsageRepository(prisma: PrismaClient): AiUsageRepository {
  const sum = async (since?: Date) => {
    const result = await prisma.aiUsage.aggregate({
      _sum: { costUsd: true },
      ...(since ? { where: { createdAt: { gte: since } } } : {}),
    });
    return Number(result._sum.costUsd ?? 0);
  };

  return {
    async record(input) {
      await prisma.aiUsage.create({
        data: {
          task: input.task,
          status: input.status,
          provider: input.provider,
          model: input.model,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          costUsd: input.costUsd.toFixed(6),
          latencyMs: input.latencyMs,
          promptVersion: input.promptVersion,
          reason: input.reason ?? null,
          error: input.error ? input.error.slice(0, 2_000) : null,
          ingestionRunId: input.ingestionRunId ?? null,
          messageId: input.messageId ?? null,
          contactId: input.contactId ?? null,
        },
      });
    },

    spentTotalUsd: () => sum(),
    spentSinceUsd: (since) => sum(since),

    async extractionsForContactSince(contactId, since) {
      return prisma.aiUsage.count({
        where: { contactId, task: "extract", status: "ok", createdAt: { gte: since } },
      });
    },
  };
}
