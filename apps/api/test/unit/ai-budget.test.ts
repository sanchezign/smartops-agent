import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pino } from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetExceededError, createAiClient } from "../../src/ai/ai.client.js";
import { assertPricedModels } from "../../src/ai/ai.factory.js";
import { checkBudget, startOfUtcDay } from "../../src/ai/budget.js";
import { LlmError, type LlmProvider, type StructuredRequest } from "../../src/ai/llm-provider.js";
import {
  costUsd,
  estimateInputTokens,
  estimateMaxCostUsd,
  imageDimensions,
  imageTokens,
  modelPrice,
  pdfPageCount,
} from "../../src/ai/pricing.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import type { AiUsageRepository, RecordUsageInput } from "../../src/ai/usage.repository.js";

const PHOTO = readFileSync(
  new URL("../fixtures/extraction/lista-precios-foto.jpg", import.meta.url),
);
const PDF = readFileSync(new URL("../fixtures/extraction/lista-prueba.pdf", import.meta.url));
const log = pino({ level: "silent" });
const tmp = mkdtempSync(join(tmpdir(), "smartops-prompts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("pricing (verified 2026-09-25)", () => {
  it("prices Sonnet 5 and Haiku 4.5 per million tokens", () => {
    expect(modelPrice("claude-sonnet-5")).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
      minCacheableTokens: 1024,
    });
    expect(modelPrice("claude-haiku-4-5")).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 5,
      minCacheableTokens: 4096,
    });
  });

  it("refuses unknown models (never under-count)", () => {
    expect(() => modelPrice("claude-imaginary-9")).toThrow(/no pricing/);
    expect(() =>
      assertPricedModels({
        AI_PROVIDER: "fake",
        ANTHROPIC_API_KEY: undefined,
        AI_TIMEOUT_MS: 1,
        AI_CLASSIFIER_MODEL: "claude-sonnet-5",
        AI_EXTRACTOR_MODEL: "gpt-5",
        AI_FAKE_GOLDEN_DIR: "x",
      }),
    ).toThrow(/no verified price/);
  });

  it("bills input, output, cache writes (1.25x) and cache reads (0.1x) separately", () => {
    // Sonnet 5: 1000 in * $2 + 500 out * $10 + 2000 write * $2.5 + 4000 read * $0.2 = $0.0128 per 1M scale
    expect(
      costUsd("claude-sonnet-5", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 2000,
        cacheReadTokens: 4000,
      }),
    ).toBeCloseTo((1000 * 2 + 500 * 10 + 2000 * 2.5 + 4000 * 0.2) / 1e6, 10);
  });

  it("measures the real test files: photo 900x620 = 759 visual tokens, PDF = 1 page", () => {
    expect(imageDimensions(PHOTO)).toEqual({ width: 900, height: 620 });
    expect(imageTokens(900, 620)).toBe(759);
    expect(pdfPageCount(PDF)).toBe(1);
  });

  it("estimates input tokens conservatively and the worst-case cost", () => {
    const tokens = estimateInputTokens("x".repeat(3000), [
      { type: "image", mediaType: "image/jpeg", data: PHOTO },
      { type: "pdf", data: PDF },
      { type: "text", text: "y".repeat(300) },
    ]);
    expect(tokens).toBe(1000 + 759 + 4600 + 100);
    expect(estimateMaxCostUsd("claude-sonnet-5", tokens, 4000)).toBeCloseTo(
      (tokens * 2 + 4000 * 10) / 1e6,
      10,
    );
  });
});

describe("budget guard", () => {
  const limits = { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20 };

  it("allows calls within all limits", () => {
    expect(
      checkBudget(
        limits,
        { spentTotalUsd: 1, spentTodayUsd: 0.1, contactExtractionsToday: 3 },
        { estimatedCostUsd: 0.05, isExtraction: true },
      ),
    ).toEqual({ allowed: true });
  });

  it.each([
    [
      "total",
      { spentTotalUsd: 3.98, spentTodayUsd: 0, contactExtractionsToday: 0 },
      "total_budget_exceeded",
    ],
    [
      "daily",
      { spentTotalUsd: 1, spentTodayUsd: 0.49, contactExtractionsToday: 0 },
      "daily_budget_exceeded",
    ],
    [
      "per-contact",
      { spentTotalUsd: 1, spentTodayUsd: 0.1, contactExtractionsToday: 20 },
      "contact_daily_limit",
    ],
  ] as const)("blocks when the %s limit would be exceeded", (_l, spend, reason) => {
    expect(
      checkBudget(limits, spend, { estimatedCostUsd: 0.05, isExtraction: true }),
    ).toMatchObject({ allowed: false, reason });
  });

  it("the per-contact limit applies to extractions only", () => {
    expect(
      checkBudget(
        limits,
        { spentTotalUsd: 0, spentTodayUsd: 0, contactExtractionsToday: 99 },
        { estimatedCostUsd: 0.001, isExtraction: false },
      ),
    ).toEqual({ allowed: true });
  });

  it("days are UTC", () => {
    expect(startOfUtcDay(new Date("2026-09-25T02:30:00-03:00")).toISOString()).toBe(
      "2026-09-25T00:00:00.000Z",
    );
  });
});

describe("AI client", () => {
  const schema = z.object({ ok: z.boolean() });
  const req: StructuredRequest<{ ok: boolean }> = {
    task: "extract",
    model: "claude-sonnet-5",
    system: "sys",
    cacheSystem: false,
    content: [{ type: "text", text: "hola" }],
    jsonSchema: {},
    schema,
    effort: "medium",
    maxTokens: 4000,
  };

  function usageRepo(spent: { total?: number; today?: number; contact?: number } = {}) {
    const rows: RecordUsageInput[] = [];
    const repo: AiUsageRepository = {
      record: vi.fn(async (row) => {
        rows.push(row);
      }),
      spentTotalUsd: vi.fn(async () => spent.total ?? 0),
      spentSinceUsd: vi.fn(async () => spent.today ?? 0),
      extractionsForContactSince: vi.fn(async () => spent.contact ?? 0),
    };
    return { repo, rows };
  }

  const anthropicLike = (impl: LlmProvider["generateStructured"]): LlmProvider => ({
    name: "anthropic",
    generateStructured: impl,
  });
  const limits = { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20 };
  const ctx = {
    promptVersion: "extractor@abc",
    messageId: "m1",
    contactId: "c1",
    ingestionRunId: "r1",
    log,
  };

  it("records tokens and the computed cost of a successful call", async () => {
    const { repo, rows } = usageRepo();
    const client = createAiClient({
      provider: anthropicLike(async () => ({
        data: { ok: true } as never,
        usage: {
          inputTokens: 3000,
          outputTokens: 1500,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
        },
        model: "claude-sonnet-5",
        latencyMs: 4200,
        stopReason: "end_turn",
      })),
      usage: repo,
      limits,
    });
    const result = await client.generateStructured(req, ctx);
    const expected = (3000 * 2 + 2000 * 0.2 + 1500 * 10) / 1e6;
    expect(result.costUsd).toBeCloseTo(expected, 10);
    expect(rows[0]).toMatchObject({
      task: "extract",
      status: "ok",
      provider: "anthropic",
      model: "claude-sonnet-5",
      promptVersion: "extractor@abc",
      ingestionRunId: "r1",
      contactId: "c1",
      latencyMs: 4200,
    });
    expect(rows[0]?.costUsd).toBeCloseTo(expected, 10);
  });

  it("blocks BEFORE calling the provider when the budget would be exceeded, and records it", async () => {
    const { repo, rows } = usageRepo({ total: 3.99 });
    const provider = vi.fn();
    const client = createAiClient({ provider: anthropicLike(provider), usage: repo, limits });
    const err = await client.generateStructured(req, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ reason: "total_budget_exceeded" });
    expect(provider).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      status: "budget_blocked",
      reason: "total_budget_exceeded",
      costUsd: 0,
    });
  });

  it("records failed calls, including tokens billed for an invalid output", async () => {
    const { repo, rows } = usageRepo();
    const client = createAiClient({
      provider: anthropicLike(async () => {
        throw new LlmError("invalid_output", false, "bad", {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      }),
      usage: repo,
      limits,
    });
    await expect(client.generateStructured(req, ctx)).rejects.toBeInstanceOf(LlmError);
    expect(rows[0]).toMatchObject({ status: "error", reason: "invalid_output" });
    expect(rows[0]?.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 10);
  });

  it("the fake provider is free and skips the budget check", async () => {
    const { repo, rows } = usageRepo({ total: 999 });
    const client = createAiClient({
      provider: {
        name: "fake",
        generateStructured: async () => ({
          data: { ok: true } as never,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "claude-sonnet-5",
          latencyMs: 0,
          stopReason: "end_turn",
        }),
      },
      usage: repo,
      limits,
    });
    expect((await client.generateStructured(req, ctx)).costUsd).toBe(0);
    expect(rows[0]).toMatchObject({ status: "ok", provider: "fake", costUsd: 0 });
    expect(repo.spentTotalUsd).not.toHaveBeenCalled();
  });
});

describe("versioned prompts", () => {
  it("loads a prompt file with a content-hash version", () => {
    writeFileSync(join(tmp, "sample.md"), "Sos un extractor de listas de precios.\n");
    const prompt = loadPrompt("sample", pathToFileURL(`${tmp}/`));
    expect(prompt.text).toBe("Sos un extractor de listas de precios.");
    expect(prompt.version).toMatch(/^sample@[0-9a-f]{12}$/);
    writeFileSync(join(tmp, "sample.md"), "Otro texto");
    expect(loadPrompt("sample", pathToFileURL(`${tmp}/`)).version).not.toBe(prompt.version);
  });

  it("rejects unsafe names and empty prompts", () => {
    expect(() => loadPrompt("../secrets")).toThrow(/invalid prompt name/);
    writeFileSync(join(tmp, "empty.md"), "  \n");
    expect(() => loadPrompt("empty", pathToFileURL(`${tmp}/`))).toThrow(/empty/);
  });
});
