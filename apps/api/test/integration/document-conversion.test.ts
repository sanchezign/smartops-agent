import { createHash } from "node:crypto";
import { pino } from "pino";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createFakeLlmProvider, type FakeResponder } from "../../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import type { PrismaClient } from "../../src/common/db.js";
import { AppError } from "../../src/common/errors/app-error.js";
import { createEnqueueDocumentConversionInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import {
  createDocumentConversionRepository,
  createOnDocumentStoredInTx,
} from "../../src/modules/documents/document-conversion.repository.js";
import { createDocumentConversionService } from "../../src/modules/documents/document-conversion.service.js";
import { createIsolatedDocumentConverter } from "../../src/modules/documents/document-converter.js";
import { DEFAULT_CONVERSION_LIMITS } from "../../src/modules/documents/document-types.js";
import type { ExtractionOutput } from "../../src/modules/extraction/extraction.schemas.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import {
  createIngestionService,
  type StoredExtraction,
} from "../../src/modules/extraction/ingestion.service.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import {
  composeOnStoredInTx,
  createMediaRepository,
} from "../../src/modules/media/media.repository.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import {
  DOCX_MIME,
  XLSX_MIME,
  formulaWithoutValueWorkbook,
  priceListDocx,
  priceListWorkbook,
  workbookFromRows,
  zipBomb,
} from "../helpers/documents.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Document pipeline against Postgres (phase 5 M3a): media stored → pending conversion +
 * job (atomic, real pg-boss) → isolated conversion → extraction (fake LLM) → ingest.
 * Also the run status endpoint's data (getRun). $0: no real LLM.
 */

const log = pino({ level: "silent" });

const extracted = (
  items: { name: string; price: string }[],
  listKind: "full_list" | "partial_update" = "partial_update",
) =>
  ({
    isPriceList: true,
    listKind,
    fullListEvidence: listKind === "full_list" ? "Lista completa noviembre" : null,
    supplierName: "Distribuidora Ejemplo",
    currency: "UYU",
    validFrom: null,
    taxIncluded: true,
    globalChangePct: null,
    items: items.map((i) => ({
      ...i,
      sku: null,
      unit: "unidad",
      priceChangePct: null,
      currency: null,
      available: null,
      stock: null,
      catalogRef: null,
      matchConfidence: "high",
      uncertain: false,
      note: null,
    })),
    warnings: [],
    suspiciousInstructions: false,
  }) satisfies ExtractionOutput;

describe.skipIf(!testDatabaseUrl)("document conversion pipeline (Postgres)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE review_items, alerts, price_changes, ai_usages, ingestion_runs, products, suppliers, document_conversions, media_blobs CASCADE",
    );
    await boss.deleteAllJobs(QUEUES.documentConversion);
  });

  const conversions = () => createDocumentConversionRepository(prisma);
  const converter = createIsolatedDocumentConverter(DEFAULT_CONVERSION_LIMITS);
  const conversionService = () =>
    createDocumentConversionService({
      repository: conversions(),
      storage: createPostgresMediaStorage(prisma),
      converter,
    });

  function services(extract?: FakeResponder) {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const ai = createAiClient({
      provider: createFakeLlmProvider({
        responders: { ...FAKE_RESPONDERS, ...(extract ? { extract } : {}) },
      }),
      usage: createAiUsageRepository(prisma),
      limits: { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20, runUsd: 0.3 },
    });
    return {
      extraction: createIngestionService({
        repository: createIngestionRepository(prisma),
        storage: createPostgresMediaStorage(prisma),
        ai,
        prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
        models: {
          classifier: "claude-sonnet-5",
          extractor: "claude-sonnet-5",
          cacheSystemPrompts: true,
        },
      }),
      ingest: createCatalogIngestService({ repository: createCatalogRepository(prisma), settings }),
    };
  }

  /** A document message whose media goes pending → stored through the real hook. */
  async function storedDocument(bytes: Uint8Array, mimeType: string, filename: string) {
    const contact = await prisma.contact.create({
      data: { waId: `59899${Math.floor(Math.random() * 1e6)}`, name: "Ana" },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const media = await prisma.mediaFile.create({
      data: { waMediaId: `wm-${Math.random()}`, mimeType, filename, status: "pending" },
    });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "document",
        author: "contact",
        mediaFileId: media.id,
        waTimestamp: new Date(),
      },
    });
    await createPostgresMediaStorage(prisma).put(media.id, bytes);
    const repository = createMediaRepository(prisma, {
      onStoredInTx: composeOnStoredInTx(
        createOnDocumentStoredInTx({
          enqueueConversionInTx: createEnqueueDocumentConversionInTx(boss),
        }),
      ),
    });
    const sha = createHash("sha256").update(bytes).digest("hex");
    await repository.markStored(media.id, {
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: sha,
      contentSha256: sha,
      storage: "postgres",
      kind: "document",
    });
    return { mediaFileId: media.id, messageId: message.id };
  }

  it("media stored → pending conversion + job (atomic); the worker converts it in isolation", async () => {
    const { mediaFileId } = await storedDocument(priceListWorkbook(), XLSX_MIME, "lista.xlsx");
    expect(
      await prisma.documentConversion.findUniqueOrThrow({ where: { mediaFileId } }),
    ).toMatchObject({ status: "pending" });
    expect(await boss.findJobs(QUEUES.documentConversion, { data: { mediaFileId } })).toHaveLength(
      1,
    );

    expect(await conversionService().processConversion(mediaFileId, log)).toEqual({
      status: "done",
    });
    const row = await prisma.documentConversion.findUniqueOrThrow({ where: { mediaFileId } });
    expect(row).toMatchObject({
      status: "done",
      format: "xlsx",
      dataRows: 6,
      truncated: false,
      needsReview: false,
      attempts: 1,
    });
    expect(row.text).toContain("| Selladores | Silicona transparente 280ml | unidad | 310.5 |");
    expect(row.converterVersion).toMatch(/xlsx 0\.20\.3/);
    // A duplicate job does nothing.
    expect(await conversionService().processConversion(mediaFileId, log)).toEqual({
      status: "skipped",
      reason: "done",
    });
  }, 30_000);

  it("PDFs and images get no conversion", async () => {
    const { mediaFileId } = await storedDocument(
      new TextEncoder().encode("%PDF-1.4"),
      "application/pdf",
      "a.pdf",
    );
    expect(await prisma.documentConversion.count({ where: { mediaFileId } })).toBe(0);
  });

  it("extraction waits for the conversion (NOT_READY), then sends <document_text> to the LLM", async () => {
    const { mediaFileId, messageId } = await storedDocument(
      priceListDocx(),
      DOCX_MIME,
      "lista.docx",
    );
    let seenText = "";
    const svc = services((request) => {
      seenText = request.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return extracted([{ name: "Silicona transparente 280ml", price: "310" }]);
    });
    // Like a voice note being transcribed: the message is not ready yet.
    const early = await svc.extraction.classify(messageId, log).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(AppError);
    expect(early).toMatchObject({
      code: "NOT_READY",
      message: "Document is still being converted",
    });

    await conversionService().processConversion(mediaFileId, log);
    const { runId } = await svc.extraction.classify(messageId, log);
    expect(await svc.extraction.extract(runId, log)).toMatchObject({
      status: "extracted",
      itemCount: 1,
    });
    expect(seenText).toContain("<document_text>");
    expect(seenText).toContain("| Silicona transparente 280ml | unidad | 310 |");
    expect(await svc.ingest.ingest(runId, log)).toMatchObject({
      status: "ingested",
      counts: { created: 1 },
    });

    const view = await svc.extraction.getRun(runId);
    expect(view).toMatchObject({
      runId,
      status: "ingested",
      itemCount: 1,
      listKind: "partial_update",
      ingest: { pendingReviews: 0, counts: { created: 1 } },
      document: { status: "done", format: "docx", truncated: false, needsReview: false },
    });
  }, 30_000);

  it("a rejected document (ZIP bomb) → conversion failed → run to review without calling the LLM", async () => {
    const { mediaFileId, messageId } = await storedDocument(zipBomb(150), XLSX_MIME, "bomba.xlsx");
    expect(await conversionService().processConversion(mediaFileId, log)).toEqual({
      status: "failed",
      reason: "zip_bomb",
    });
    const svc = services();
    const { runId } = await svc.extraction.classify(messageId, log);
    expect(await svc.extraction.extract(runId, log)).toMatchObject({ status: "needs_review" });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errors).toMatchObject({ reason: "document_zip_bomb" });
    expect(await prisma.aiUsage.count({ where: { task: "extract" } })).toBe(0);
    expect(
      await prisma.reviewItem.findFirstOrThrow({ where: { ingestionRunId: runId } }),
    ).toMatchObject({
      kind: "extraction_failed",
      reasons: ["document_zip_bomb"],
    });
  }, 30_000);

  it("more than 30 product lines → review 'requires chunked extraction' (never half a list)", async () => {
    const rows = [
      ["Producto", "Precio"],
      ...Array.from({ length: 31 }, (_, i) => [`Item ${i}`, i + 1]),
    ];
    const { mediaFileId, messageId } = await storedDocument(
      workbookFromRows(rows),
      XLSX_MIME,
      "grande.xlsx",
    );
    await conversionService().processConversion(mediaFileId, log);
    const svc = services();
    const { runId } = await svc.extraction.classify(messageId, log);
    expect(await svc.extraction.extract(runId, log)).toMatchObject({ status: "needs_review" });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errors).toMatchObject({ reason: "requires_chunked_extraction" });
    expect(await prisma.aiUsage.count()).toBe(0);
    expect((await svc.extraction.getRun(runId)).document).toMatchObject({ dataRows: 31 });
  }, 30_000);

  it("formula without value → never a full list, and every line goes to review", async () => {
    const { mediaFileId, messageId } = await storedDocument(
      formulaWithoutValueWorkbook(),
      XLSX_MIME,
      "formulas.xlsx",
    );
    await conversionService().processConversion(mediaFileId, log);
    const svc = services(() =>
      extracted([{ name: "Silicona transparente 280ml", price: "310" }], "full_list"),
    );
    const { runId } = await svc.extraction.classify(messageId, log);
    expect(await svc.extraction.extract(runId, log)).toMatchObject({
      status: "extracted",
      listKind: "partial_update",
    });
    const stored = (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId } }))
      .rawExtraction as unknown as StoredExtraction;
    expect(stored.documentIncomplete).toBe(true);
    expect(stored.output.warnings.join(" ")).toMatch(/fórmulas sin valor/);

    expect(await svc.ingest.ingest(runId, log)).toMatchObject({
      status: "ingested",
      counts: { created: 0, review: 1 },
    });
    const [review] = await prisma.reviewItem.findMany({ where: { ingestionRunId: runId } });
    expect(review?.reasons).toContain("document_incomplete");
  }, 30_000);
});
