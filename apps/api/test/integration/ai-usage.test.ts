import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import { createTestPrisma, testDatabaseUrl } from "./db.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe.skipIf(!testDatabaseUrl)("AI usage ledger (Postgres)", () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe("TRUNCATE TABLE ai_usages");
  });

  it("sums spend (total and since a date) with exact decimals and counts contact extractions", async () => {
    const repo = createAiUsageRepository(prisma);
    const base = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      latencyMs: 100,
      promptVersion: "p@1",
    };
    await repo.record({
      ...base,
      task: "extract",
      status: "ok",
      usage: { ...zero, inputTokens: 3000 },
      costUsd: 0.012345,
      contactId: "0199a1b2-0000-7000-8000-000000000001",
    });
    await repo.record({
      ...base,
      task: "classify",
      status: "ok",
      usage: zero,
      costUsd: 0.0015,
      contactId: "0199a1b2-0000-7000-8000-000000000001",
    });
    await repo.record({
      ...base,
      task: "extract",
      status: "budget_blocked",
      usage: zero,
      costUsd: 0,
      reason: "daily_budget_exceeded",
      contactId: "0199a1b2-0000-7000-8000-000000000001",
    });
    await prisma.aiUsage.updateMany({
      where: { task: "classify" },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });

    expect(await repo.spentTotalUsd()).toBeCloseTo(0.013845, 6);
    expect(await repo.spentSinceUsd(new Date("2026-06-01T00:00:00Z"))).toBeCloseTo(0.012345, 6);
    // Only successful extractions count towards the per-contact limit.
    expect(
      await repo.extractionsForContactSince("0199a1b2-0000-7000-8000-000000000001", new Date(0)),
    ).toBe(1);
  });
});
