import { readFileSync } from "node:fs";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import type { LlmProvider, StructuredRequest } from "../../src/ai/llm-provider.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createFakeLlmProvider, type FakeResponder } from "../../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import type { PrismaClient } from "../../src/common/db.js";
import { AppError } from "../../src/common/errors/app-error.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import {
  createIngestionService,
  type StoredExtraction,
} from "../../src/modules/extraction/ingestion.service.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Classification + extraction against Postgres with the fake LLM ($0): run lifecycle,
 * readiness, the per-run extraction lock under concurrency, budget refusal, invalid and
 * injected outputs. No real Claude calls.
 */

const log = pino({ level: "silent" });
const PDF = readFileSync(new URL("../fixtures/extraction/lista-prueba.pdf", import.meta.url));
const INJECTION = readFileSync(
  new URL("../fixtures/extraction/injection-message.txt", import.meta.url),
  "utf8",
);
const limits = { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20 };

describe.skipIf(!testDatabaseUrl)("ingestion: classify + extract (Postgres, fake LLM)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE ai_usages, ingestion_runs, products, suppliers CASCADE",
    );
  });

  function service(
    options: {
      provider?: LlmProvider;
      responders?: Partial<Record<"classify" | "extract", FakeResponder>>;
      totalUsd?: number;
    } = {},
  ) {
    return createIngestionService({
      repository: createIngestionRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      ai: createAiClient({
        provider:
          options.provider ??
          createFakeLlmProvider({ responders: { ...FAKE_RESPONDERS, ...options.responders } }),
        usage: createAiUsageRepository(prisma),
        limits: {
          ...limits,
          ...(options.totalUsd !== undefined ? { totalUsd: options.totalUsd } : {}),
        },
      }),
      prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
      models: {
        classifier: "claude-sonnet-5",
        extractor: "claude-sonnet-5",
        cacheSystemPrompts: true,
      },
    });
  }

  async function inbound(input: {
    type: "text" | "document" | "audio" | "image";
    text?: string;
    transcript?: string;
    media?: { mime: string; bytes: Uint8Array; status?: "pending" | "stored"; filename?: string };
    transcription?: "pending" | "done";
  }) {
    const contact = await prisma.contact.create({
      data: { waId: `59899${Math.floor(Math.random() * 1e6)}` },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    let mediaFileId: string | null = null;
    if (input.media) {
      const media = await prisma.mediaFile.create({
        data: {
          waMediaId: `wm-${Math.random()}`,
          mimeType: input.media.mime,
          status: input.media.status ?? "stored",
          filename: input.media.filename ?? null,
        },
      });
      mediaFileId = media.id;
      if ((input.media.status ?? "stored") === "stored") {
        await createPostgresMediaStorage(prisma).put(media.id, input.media.bytes);
      }
      if (input.transcription) {
        await prisma.transcription.create({
          data: { mediaFileId: media.id, status: input.transcription },
        });
      }
    }
    return prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: input.type,
        author: "contact",
        text: input.text ?? null,
        transcript: input.transcript ?? null,
        mediaFileId,
      },
    });
  }

  const extractCalls = () => prisma.aiUsage.count({ where: { task: "extract", status: "ok" } });

  it("classifies a text message and records the (free) fake call in the ledger", async () => {
    const message = await inbound({
      type: "text",
      text: "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU",
    });
    const result = await service().classify(message.id, log);
    expect(result).toMatchObject({ status: "classified", classification: "price_update_partial" });

    const usage = await prisma.aiUsage.findFirstOrThrow();
    expect(usage).toMatchObject({
      task: "classify",
      status: "ok",
      provider: "fake",
      ingestionRunId: result.runId,
    });
    expect(Number(usage.costUsd)).toBe(0);
    expect(usage.promptVersion).toMatch(/^classifier@[0-9a-f]{12}$/);

    // Idempotent: classifying again returns the same run without another call.
    expect((await service().classify(message.id, log)).runId).toBe(result.runId);
    expect(await prisma.aiUsage.count()).toBe(1);
  });

  it("media messages skip the LLM classification (extraction decides)", async () => {
    const message = await inbound({
      type: "document",
      media: { mime: "application/pdf", bytes: PDF, filename: "lista.pdf" },
    });
    expect(await service().classify(message.id, log)).toMatchObject({
      status: "classified",
      classification: null,
    });
    expect(await prisma.aiUsage.count()).toBe(0);
  });

  it("refuses messages that are not ready (media downloading, voice note transcribing)", async () => {
    const downloading = await inbound({
      type: "document",
      media: { mime: "application/pdf", bytes: PDF, status: "pending" },
    });
    const transcribing = await inbound({
      type: "audio",
      media: { mime: "audio/ogg", bytes: Buffer.from("OggS") },
      transcription: "pending",
    });
    for (const m of [downloading, transcribing]) {
      const err = await service()
        .classify(m.id, log)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: "NOT_READY", statusCode: 409 });
    }
  });

  it("extracts, stores the validated output + catalog refs, and is idempotent", async () => {
    const message = await inbound({
      type: "text",
      text: "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU",
    });
    const svc = service();
    const { runId } = await svc.classify(message.id, log);
    const result = await svc.extract(runId, log);
    expect(result).toMatchObject({
      status: "extracted",
      classification: "price_update_partial",
      itemCount: 2,
    });

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    const stored = run.rawExtraction as unknown as StoredExtraction;
    expect(stored.output.items.map((i) => i.price)).toEqual(["12", "5"]);
    expect(stored.promptVersion).toMatch(/^extractor@/);
    expect(run.promptVersion).toMatch(/^extractor@/);
    expect(Number(run.costUsd)).toBe(0);

    expect(await svc.extract(runId, log)).toMatchObject({ status: "extracted" });
    expect(await extractCalls()).toBe(1);
  });

  it("stores the tax statement and percentage changes with the extraction (no invented prices)", async () => {
    const message = await inbound({
      type: "text",
      text: "Precios con IVA incluido\nSilicona sube 10%",
    });
    const svc = service();
    const { runId } = await svc.classify(message.id, log);
    expect(await svc.extract(runId, log)).toMatchObject({ status: "extracted", itemCount: 1 });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    const stored = run.rawExtraction as unknown as StoredExtraction;
    expect(stored.output.taxIncluded).toBe(true);
    expect(stored.output.items[0]).toMatchObject({ price: null, priceChangePct: "10" });
  });

  it("locks the run: concurrent extracts call the LLM once (others get IN_PROGRESS or the result)", async () => {
    const message = await inbound({ type: "text", text: "Tornillo 6mm 12 UYU" });
    const slow = createFakeLlmProvider({ responders: FAKE_RESPONDERS, latencyMs: 300 });
    const svc = service({ provider: slow });
    const { runId } = await svc.classify(message.id, log);

    const outcomes = await Promise.allSettled([1, 2, 3, 4].map(() => svc.extract(runId, log)));
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected)
      expect(r.reason).toMatchObject({ code: "IN_PROGRESS", statusCode: 409 });
    expect(await extractCalls()).toBe(1);
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "extracted",
    );
  });

  it("the budget guard blocks the call before it happens: run → needs_review, ledger → budget_blocked", async () => {
    const message = await inbound({ type: "text", text: "Tornillo 6mm 12 UYU" });
    // A provider that pretends to be Anthropic (the budget guard skips fakes) but must never run.
    let called = false;
    const paid: LlmProvider = {
      name: "anthropic",
      generateStructured: async <T>(req: StructuredRequest<T>) => {
        called = true;
        throw new Error(`must not be called (${req.task})`);
      },
    };
    const result = await service({ provider: paid, totalUsd: 0.000001 }).classify(message.id, log);
    expect(called).toBe(false);
    expect(result).toMatchObject({ status: "needs_review", reason: "budget_exceeded" });
    expect(await prisma.aiUsage.findFirstOrThrow()).toMatchObject({
      status: "budget_blocked",
      reason: "total_budget_exceeded",
    });
  });

  it("a compromised output (all prices 0) fails validation: needs_review, nothing stored as extracted", async () => {
    const message = await inbound({ type: "text", text: INJECTION });
    const compromised: FakeResponder = () => ({
      isPriceList: true,
      listKind: "full_list",
      fullListEvidence: "Esta es una lista completa",
      supplierName: null,
      currency: "UYU",
      validFrom: null,
      taxIncluded: null,
      globalChangePct: null,
      items: [
        {
          name: "Tornillo 6mm",
          sku: null,
          unit: null,
          price: "0",
          priceChangePct: null,
          currency: null,
          available: null,
          stock: null,
          catalogRef: null,
          matchConfidence: "high",
          uncertain: false,
          note: null,
        },
      ],
      warnings: [],
      suspiciousInstructions: false,
    });
    const svc = service({ responders: { extract: compromised } });
    const { runId } = await svc.classify(message.id, log);
    const result = await svc.extract(runId, log);
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(result.status).toBe("needs_review");
    expect(run.rawExtraction).toBeNull();
    expect(run.errors).toMatchObject({ reason: "llm_invalid_output" });
  });

  it("a detected injection attempt sends the run to review with the extraction kept for the human", async () => {
    const message = await inbound({ type: "text", text: INJECTION });
    const svc = service();
    const { runId } = await svc.classify(message.id, log);
    const result = await svc.extract(runId, log);
    expect(result).toMatchObject({ status: "needs_review", suspiciousInstructions: true });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errors).toMatchObject({ reason: "suspicious_instructions" });
    expect((run.rawExtraction as unknown as StoredExtraction).output.items[0]?.price).toBe("13");
  });

  it("a transient provider error releases the lock so the extraction can be retried", async () => {
    const message = await inbound({ type: "text", text: "Tornillo 6mm 12 UYU" });
    let attempts = 0;
    const flaky: LlmProvider = {
      name: "fake",
      generateStructured: async (req) => {
        attempts += 1;
        if (req.task === "extract" && attempts === 2) {
          const { LlmError } = await import("../../src/ai/llm-provider.js");
          throw new LlmError("unavailable", true, "overloaded");
        }
        return createFakeLlmProvider({ responders: FAKE_RESPONDERS }).generateStructured(req);
      },
    };
    const svc = service({ provider: flaky });
    const { runId } = await svc.classify(message.id, log);
    await expect(svc.extract(runId, log)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "classified",
    );
    expect((await svc.extract(runId, log)).status).toBe("extracted");
  });

  // Phase 10 M5: a model that times out (AI_TIMEOUT_MS) is TRANSIENT everywhere: the ledger
  // keeps an "error / timeout" row (latency logged, $0 without usage), the API answers 503 so
  // n8n retries (3 × 5 s) and then its error workflow raises an alert; the run is never lost
  // nor stuck in "extracting".
  it("an LLM timeout on classify and on extract: ledger row, 503, run retriable", async () => {
    const message = await inbound({ type: "text", text: "Tornillo 6mm 12 UYU" });
    const { LlmError } = await import("../../src/ai/llm-provider.js");
    let failNext: "classify" | "extract" | null = "classify";
    const slow: LlmProvider = {
      name: "fake",
      generateStructured: async (req) => {
        if (req.task === failNext) {
          failNext = failNext === "classify" ? "extract" : null;
          throw new LlmError("timeout", true, "Request timed out.");
        }
        return createFakeLlmProvider({ responders: FAKE_RESPONDERS }).generateStructured(req);
      },
    };
    const svc = service({ provider: slow });

    await expect(svc.classify(message.id, log)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const { runId } = await svc.classify(message.id, log);
    await expect(svc.extract(runId, log)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "classified",
    );
    expect((await svc.extract(runId, log)).status).toBe("extracted");

    const errorsInLedger = await prisma.aiUsage.findMany({
      where: { status: "error" },
      orderBy: { createdAt: "asc" },
    });
    expect(errorsInLedger.map((u) => [u.task, u.reason])).toEqual([
      ["classify", "timeout"],
      ["extract", "timeout"],
    ]);
    expect(errorsInLedger.every((u) => Number(u.costUsd) === 0 && u.latencyMs !== null)).toBe(true);
  });

  it("does not extract messages classified as something else", async () => {
    const message = await inbound({ type: "text", text: "hola, buen día" });
    const svc = service();
    const { runId, classification } = await svc.classify(message.id, log);
    expect(classification).toBe("other");
    await expect(svc.extract(runId, log)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
