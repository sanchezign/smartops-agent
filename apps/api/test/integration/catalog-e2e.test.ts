import { readFileSync } from "node:fs";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import { createLlmProvider } from "../../src/ai/ai.factory.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/common/db.js";
import { parseEnv } from "../../src/config/env.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import { createIngestionService } from "../../src/modules/extraction/ingestion.service.js";
import { convertDocument } from "../../src/modules/documents/convert.js";
import { createDocumentConversionRepository } from "../../src/modules/documents/document-conversion.repository.js";
import { DEFAULT_CONVERSION_LIMITS } from "../../src/modules/documents/document-types.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import { createSheetExtraction } from "../../src/modules/sheets/sheet-extraction.js";
import { createSheetFormatRepository } from "../../src/modules/sheets/sheet-format.repository.js";
import { XLSX_MIME } from "../helpers/documents.js";
import { createReviewRepository } from "../../src/modules/reviews/review.repository.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import {
  createFakeWebhookQueue,
  createInMemoryWebhookRepository,
  healthyDb,
  stubInternalDeps,
  TEST_ENV_SOURCE,
  TEST_INTERNAL_API_KEY,
  stubAuthService,
} from "../helpers/build-app.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * End to end over HTTP (phase 5 M4): the internal API that n8n will call, composed like
 * server.ts, against Postgres, with the fake LLM serving the RECORDED golden outputs
 * ($0). September PDF → October photo must give exactly what expected.json says.
 */

const FIXTURES = new URL("../fixtures/extraction/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));
const PDF = read("lista-prueba.pdf");
const PHOTO = read("lista-precios-foto.jpg");
const TRANSCRIPT = read("voice-transcript.txt").toString("utf8").trim();
const INJECTION = read("injection-message.txt").toString("utf8").trim();
const EXPECTED = JSON.parse(read("expected.json").toString("utf8")) as {
  september: { supplierName: string; products: { name: string; unit: string; price: string }[] };
  photoAgainstSeptember: {
    lines: { catalog: string; newPrice: string; outcome: "price_change" | "review" }[];
    untouched: string[];
  };
};

const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("e2e: internal API → catalog (Postgres + golden outputs)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let reviews: ReturnType<typeof createReviewService>;
  let clock = Date.parse("2026-09-25T12:00:00Z");

  beforeAll(() => {
    prisma = createTestPrisma();
    const env = parseEnv({ ...TEST_ENV_SOURCE });
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const ai = createAiClient({
      provider: createLlmProvider(env, FAKE_RESPONDERS),
      usage: createAiUsageRepository(prisma),
      limits: { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20, runUsd: 0.3 },
    });
    const ingestion = createIngestionService({
      repository: createIngestionRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      ai,
      sheets: createSheetExtraction({
        ai,
        formats: createSheetFormatRepository(prisma),
        prompts: { mapper: loadPrompt("column-mapper"), matcher: loadPrompt("matcher") },
        models: {
          mapper: env.AI_EXTRACTOR_MODEL,
          matcher: env.AI_EXTRACTOR_MODEL,
          cacheSystemPrompts: env.AI_PROMPT_CACHE,
        },
      }),
      prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
      models: {
        classifier: env.AI_CLASSIFIER_MODEL,
        extractor: env.AI_EXTRACTOR_MODEL,
        cacheSystemPrompts: env.AI_PROMPT_CACHE,
      },
    });
    const catalog = createCatalogIngestService({
      repository: createCatalogRepository(prisma),
      settings,
    });
    reviews = createReviewService({
      repository: createReviewRepository(prisma),
      ingest: catalog,
      settings,
      catalog: createCatalogRepository(prisma),
    });
    app = createApp({
      env,
      logger: log,
      healthRepository: healthyDb,
      whatsappWebhookRepository: createInMemoryWebhookRepository(),
      webhookQueue: createFakeWebhookQueue(),
      auth: stubAuthService,
      internal: {
        ingestion,
        catalog,
        settings,
        notifications: stubInternalDeps.notifications,
        supplierAck: stubInternalDeps.supplierAck,
      },
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE review_items, alerts, price_changes, ai_usages, ingestion_runs, products, supplier_sheet_formats, suppliers, settings, audit_logs, media_blobs, transcriptions, document_conversions CASCADE",
    );
  });

  const api = (path: string, body?: object) =>
    request(app)
      .post(`/api/v1/internal${path}`)
      .set("X-Internal-Api-Key", TEST_INTERNAL_API_KEY)
      .send(body ?? {});

  async function supplierContact() {
    const contact = await prisma.contact.create({
      data: { waId: "59899000160", name: "Juan (Distribuidora)" },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    return { contact, conversation };
  }

  async function inbound(
    conversationId: string,
    input: {
      type: "text" | "document" | "image" | "audio";
      text?: string;
      transcript?: string;
      media?: { mime: string; bytes: Uint8Array; filename?: string };
    },
  ) {
    clock += 3_600_000;
    let mediaFileId: string | null = null;
    if (input.media) {
      const media = await prisma.mediaFile.create({
        data: {
          waMediaId: `wm-${clock}`,
          mimeType: input.media.mime,
          status: "stored",
          filename: input.media.filename ?? null,
        },
      });
      await createPostgresMediaStorage(prisma).put(media.id, input.media.bytes);
      if (input.type === "audio")
        await prisma.transcription.create({ data: { mediaFileId: media.id, status: "done" } });
      mediaFileId = media.id;
    }
    return prisma.message.create({
      data: {
        conversationId,
        direction: "inbound",
        type: input.type,
        author: "contact",
        text: input.text ?? null,
        transcript: input.transcript ?? null,
        mediaFileId,
        waTimestamp: new Date(clock),
      },
    });
  }

  /** classify → extract → ingest over HTTP, as n8n will do. */
  async function pipeline(messageId: string) {
    const classified = await api("/classify", { messageId }).expect(200);
    const runId = classified.body.runId as string;
    const extracted = await api("/extract", { runId });
    const ingested =
      extracted.body.status === "extracted" ? await api("/catalog/ingest", { runId }) : null;
    return { runId, classified: classified.body, extracted: extracted.body, ingested };
  }

  async function seedSeptember() {
    const { contact, conversation } = await supplierContact();
    const pdf = await inbound(conversation.id, {
      type: "document",
      media: { mime: "application/pdf", bytes: PDF, filename: "lista-prueba.pdf" },
    });
    const september = await pipeline(pdf.id);
    return { contact, conversation, september };
  }

  it("September PDF creates the supplier and 7 products; the October photo gives 5 automatic changes, the washer to review, paint untouched", async () => {
    const { contact, conversation, september } = await seedSeptember();

    // ─── September PDF (new contact, no supplier) ───
    expect(september.extracted).toMatchObject({ status: "extracted", itemCount: 7 });
    expect(september.ingested?.status).toBe(200);
    const first = september.ingested!.body;
    expect(first).toMatchObject({
      status: "ingested",
      pendingReviews: 0,
      counts: { created: 7, updated: 0, review: 0, unavailableCandidates: 0 },
    });
    expect(first.warnings.map((w: { code: string }) => w.code)).toEqual(["supplier_created"]);
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: first.supplierId } });
    expect(supplier).toMatchObject({ name: EXPECTED.september.supplierName, taxIncluded: true });
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({
      supplierId: supplier.id,
      kind: "supplier",
    });
    const products = await prisma.product.findMany({ where: { supplierId: supplier.id } });
    expect(
      products
        .map((p) => [p.name, p.unit, p.price.toFixed(), p.currency, p.available])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      EXPECTED.september.products
        .map((p) => [p.name, p.unit, p.price, "UYU", true])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(await prisma.priceChange.count()).toBe(7);

    // ─── October photo ───
    const photo = await inbound(conversation.id, {
      type: "image",
      media: { mime: "image/jpeg", bytes: PHOTO },
    });
    const october = await pipeline(photo.id);
    expect(october.extracted).toMatchObject({ status: "extracted", itemCount: 6 });
    const second = october.ingested!.body;
    expect(second).toMatchObject({
      status: "ingested",
      supplierId: supplier.id,
      pendingReviews: 1,
      counts: {
        created: 0,
        updated: 5,
        unchanged: 0,
        review: 1,
        unavailableCandidates: 0,
        alerts: 2,
      },
    });
    expect(second.warnings.map((w: { code: string }) => w.code)).toEqual(["tax_not_stated"]);

    const price = async (name: string) =>
      prisma.product.findFirstOrThrow({ where: { supplierId: supplier.id, name } });
    const changes = await prisma.priceChange.findMany({
      where: { ingestionRunId: october.runId },
      include: { product: { select: { name: true } } },
    });
    const byName = new Map(changes.map((c) => [c.product.name, c]));
    for (const line of EXPECTED.photoAgainstSeptember.lines) {
      const product = await price(line.catalog);
      if (line.outcome === "price_change") {
        expect(product.price.toFixed(), line.catalog).toBe(line.newPrice);
        expect(byName.get(line.catalog)?.source, line.catalog).toBe("auto");
      } else {
        expect(byName.has(line.catalog), line.catalog).toBe(false);
      }
    }
    expect(
      Object.fromEntries(changes.map((c) => [c.product.name, c.changePct?.toFixed()])),
    ).toEqual({
      "Tornillo 6mm": "16.6667",
      "Tuerca 6mm": "20",
      "Cable 2mm": "6.6667",
      "Lampara LED 9W": "4.1667",
      "Cemento portland 25kg": "2.381",
    });
    for (const name of EXPECTED.photoAgainstSeptember.untouched) {
      const untouched = await price(name);
      expect(untouched.price.toFixed(), name).toBe("1850");
      expect(untouched.available, name).toBe(true);
    }
    const alerts = await prisma.alert.findMany({
      include: { product: { select: { name: true } } },
    });
    expect(alerts.map((a) => a.product?.name).sort()).toEqual(["Tornillo 6mm", "Tuerca 6mm"]);

    // The washer: one pending product_match for "Arandela 6mm" at the same price.
    const pending = await prisma.reviewItem.findMany({ where: { status: "pending" } });
    expect(pending).toHaveLength(1);
    const arandela = await price("Arandela 6mm");
    expect(pending[0]).toMatchObject({
      kind: "product_match",
      scope: "line",
      productId: arandela.id,
    });
    expect((pending[0]!.proposal as { proposedPrice: string }).proposedPrice).toBe("3");

    // Re-ingesting is idempotent.
    const again = await api("/catalog/ingest", { runId: october.runId }).expect(200);
    expect(again.body).toMatchObject({ status: "ingested", counts: second.counts });
    expect(await prisma.priceChange.count({ where: { ingestionRunId: october.runId } })).toBe(5);

    // A human confirms the washer: same price → nothing changes, but it is audited.
    const approved = await reviews.approve(pending[0]!.id, {}, { type: "system" }, log);
    expect(approved.resolution).toMatchObject({
      productId: arandela.id,
      price: "3",
      changed: false,
    });
    expect((await price("Arandela 6mm")).price.toFixed()).toBe("3");
    expect(await prisma.priceChange.count({ where: { productId: arandela.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "review.approve" } })).toBe(1);
  });

  it("the voice note goes to review (uncertain ASR); the injection text is gated before the catalog", async () => {
    const { conversation } = await seedSeptember();

    const voice = await inbound(conversation.id, {
      type: "audio",
      transcript: TRANSCRIPT,
      media: { mime: "audio/ogg", bytes: Buffer.from("OggS-voice-note") },
    });
    const voiceRun = await pipeline(voice.id);
    expect(voiceRun.classified).toMatchObject({ classification: "price_update_partial" });
    expect(voiceRun.ingested?.body).toMatchObject({
      status: "ingested",
      counts: { review: 1, updated: 0 },
    });
    const [voiceReview] = await prisma.reviewItem.findMany({
      where: { ingestionRunId: voiceRun.runId },
    });
    expect(voiceReview).toMatchObject({ kind: "uncertain_value" });

    const injection = await inbound(conversation.id, { type: "text", text: INJECTION });
    const injectionRun = await pipeline(injection.id);
    expect(injectionRun.extracted).toMatchObject({
      status: "needs_review",
      suspiciousInstructions: true,
    });
    expect(injectionRun.ingested).toBeNull();
    const refused = await api("/catalog/ingest", { runId: injectionRun.runId }).expect(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    const [gate] = await prisma.reviewItem.findMany({
      where: { ingestionRunId: injectionRun.runId },
    });
    expect(gate).toMatchObject({
      scope: "run",
      kind: "suspicious_instructions",
      status: "pending",
    });
    expect(
      (await prisma.product.findFirstOrThrow({ where: { name: "Tornillo 6mm" } })).price.toFixed(),
    ).toBe("12");
  });

  it("spreadsheet over HTTP: first list → column_mapping review → approved → ingested; next list at $0", async () => {
    const { conversation } = await supplierContact();
    const store = async (name: string) => {
      const bytes = readFileSync(new URL(`../fixtures/sheets/${name}`, import.meta.url));
      const message = await inbound(conversation.id, {
        type: "document",
        media: { mime: XLSX_MIME, bytes, filename: name },
      });
      const media = await prisma.message.findUniqueOrThrow({
        where: { id: message.id },
        select: { mediaFileId: true },
      });
      const result = await convertDocument(
        { bytes, mimeType: XLSX_MIME, filename: name },
        DEFAULT_CONVERSION_LIMITS,
      );
      if (!result.ok) throw new Error(result.reason);
      await prisma.documentConversion.create({ data: { mediaFileId: media.mediaFileId! } });
      await createDocumentConversionRepository(prisma).markDone(media.mediaFileId!, result, {
        durationMs: 1,
        converterVersion: "test",
      });
      return message;
    };

    const november = await pipeline((await store("precios-multiples.xlsx")).id);
    expect(november.extracted).toMatchObject({ status: "needs_review" });
    const status = await request(app)
      .get(`/api/v1/internal/runs/${november.runId}`)
      .set("X-Internal-Api-Key", TEST_INTERNAL_API_KEY)
      .expect(200);
    expect(status.body).toMatchObject({
      status: "needs_review",
      document: { status: "done", format: "xlsx" },
      reviewItems: [{ kind: "column_mapping", scope: "run", status: "pending" }],
    });

    await reviews.approve(
      status.body.reviewItems[0].id,
      { tables: [{ table: "T1", priceColumn: 4 }] },
      { type: "system" },
      log,
    );
    expect((await api("/extract", { runId: november.runId }).expect(200)).body).toMatchObject({
      status: "extracted",
      itemCount: 7,
    });
    expect(
      (await api("/catalog/ingest", { runId: november.runId }).expect(200)).body,
    ).toMatchObject({
      status: "ingested",
      counts: { created: 7 },
    });

    const aiCallsBefore = await prisma.aiUsage.count({ where: { task: "map_columns" } });
    const december = await pipeline((await store("precios-multiples-diciembre.xlsx")).id);
    expect(december.extracted).toMatchObject({ status: "extracted", itemCount: 8 });
    expect(await prisma.aiUsage.count({ where: { task: "map_columns" } })).toBe(aiCallsBefore);
    expect(december.ingested?.body).toMatchObject({
      status: "ingested",
      counts: { updated: 2, unchanged: 5 },
    });
  });

  it("the internal API requires the key, validates input and serves the rules", async () => {
    await request(app).post("/api/v1/internal/catalog/ingest").send({}).expect(401);
    const wrong = await request(app)
      .post("/api/v1/internal/extract")
      .set("X-Internal-Api-Key", "wrong-key")
      .send({ runId: "0199a1b2-0000-7000-8000-000000000001" })
      .expect(401);
    expect(wrong.body.error.code).toBe("UNAUTHORIZED");

    const invalid = await api("/catalog/ingest", { runId: "not-a-uuid" }).expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    await api("/catalog/ingest", { runId: "0199a1b2-0000-7000-8000-000000000001" }).expect(404);

    await prisma.setting.create({ data: { key: "catalog.priceAlertPct", value: 15 } });
    const rules = await request(app)
      .get("/api/v1/internal/rules")
      .set("X-Internal-Api-Key", TEST_INTERNAL_API_KEY)
      .expect(200);
    expect(rules.body.rules).toMatchObject({
      "catalog.maxIncreasePct": 50,
      "catalog.maxDecreasePct": 30,
      "catalog.priceAlertPct": 15,
      "catalog.autoCreateProducts": true,
    });
  });
});
