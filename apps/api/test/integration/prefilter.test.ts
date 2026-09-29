import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createFakeLlmProvider } from "../../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import type { PrismaClient } from "../../src/common/db.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import { createIngestionService } from "../../src/modules/extraction/ingestion.service.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import { createTranscriptionRepository } from "../../src/modules/transcription/transcription.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Phase 6 M1 against Postgres: the pre-filter inside classify() and the audio cap alert. */

const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("pre-filter and long voice notes (Postgres)", () => {
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
      "TRUNCATE TABLE ai_usages, ingestion_runs, alerts, transcriptions, media_blobs CASCADE",
    );
  });

  const service = () =>
    createIngestionService({
      repository: createIngestionRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      ai: createAiClient({
        provider: createFakeLlmProvider({ responders: FAKE_RESPONDERS }),
        usage: createAiUsageRepository(prisma),
        limits: { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20 },
      }),
      prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
      models: {
        classifier: "claude-sonnet-5",
        extractor: "claude-sonnet-5",
        cacheSystemPrompts: true,
      },
    });

  async function message(input: {
    kind?: "supplier" | "customer" | "unknown";
    type?: "text" | "sticker" | "audio";
    text?: string;
    transcription?: { status: "skipped" | "done"; reason?: string };
  }) {
    const contact = await prisma.contact.create({
      data: { waId: `59899${Math.floor(Math.random() * 1e6)}`, kind: input.kind ?? "unknown" },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    let mediaFileId: string | null = null;
    if (input.transcription) {
      const media = await prisma.mediaFile.create({
        data: { waMediaId: `wm-${Math.random()}`, mimeType: "audio/ogg", status: "stored" },
      });
      await prisma.transcription.create({
        data: {
          mediaFileId: media.id,
          status: input.transcription.status,
          reason: input.transcription.reason ?? null,
        },
      });
      mediaFileId = media.id;
    }
    return prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: input.type ?? "text",
        author: "contact",
        text: input.text ?? null,
        mediaFileId,
      },
    });
  }

  it("obvious messages are classified without any LLM call and the rule is stored", async () => {
    const svc = service();
    const cases = [
      [await message({ text: "gracias!" }), "no_price_signal", "other"],
      [await message({ type: "sticker" }), "non_content_type", "other"],
      [
        await message({ kind: "customer", text: "¿cuánto sale el candado?" }),
        "customer_contact",
        "customer_query",
      ],
      [
        await message({ type: "audio", transcription: { status: "skipped", reason: "too_long" } }),
        "audio_too_long",
        "other",
      ],
    ] as const;
    for (const [msg, rule, classification] of cases) {
      const result = await svc.classify(msg.id, log);
      expect(result, rule).toMatchObject({
        status: "classified",
        classification,
        prefilterRule: rule,
      });
    }
    expect(await prisma.aiUsage.count()).toBe(0);
    expect(await prisma.ingestionRun.count({ where: { prefilterRule: { not: null } } })).toBe(4);
  });

  it("a possible price list still reaches the classifier", async () => {
    const svc = service();
    const result = await svc.classify((await message({ text: "Tarugo 8mm 150 UYU" })).id, log);
    expect(result).toMatchObject({ classification: "price_update_partial" });
    expect(result.prefilterRule).toBeUndefined();
    expect(await prisma.aiUsage.count({ where: { task: "classify" } })).toBe(1);
  });

  it("extract refuses pre-filtered runs and customer contacts (n8n cannot skip the filter)", async () => {
    const svc = service();
    const { runId } = await svc.classify(
      (await message({ kind: "customer", text: "lista 100" })).id,
      log,
    );
    await expect(svc.extract(runId, log)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prisma.aiUsage.count()).toBe(0);
  });

  it("a voice note too long to transcribe → skipped too_long + manual_attention alert (atomic)", async () => {
    const msg = await message({ type: "audio", transcription: { status: "done" } });
    const mediaFileId = msg.mediaFileId!;
    await prisma.transcription.update({ where: { mediaFileId }, data: { status: "pending" } });
    await createTranscriptionRepository(prisma).markTooLong(mediaFileId, {
      durationSeconds: 252,
      sizeBytes: 600_000,
      maxSeconds: 180,
    });
    expect(await prisma.transcription.findUniqueOrThrow({ where: { mediaFileId } })).toMatchObject({
      status: "skipped",
      reason: "too_long",
    });
    const alert = await prisma.alert.findFirstOrThrow();
    expect(alert).toMatchObject({ type: "manual_attention" });
    expect(alert.title).toBe("Voice note of 4:12 not transcribed (limit 3 min): listen by hand");
    expect(alert.payload).toMatchObject({
      messageId: msg.id,
      reason: "audio_too_long",
      durationSeconds: 252,
      maxSeconds: 180,
    });
  });
});
