import { readFileSync } from "node:fs";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import type { LlmProvider, StructuredRequest } from "../../src/ai/llm-provider.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createFakeLlmProvider } from "../../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import type { PrismaClient } from "../../src/common/db.js";
import { AppError } from "../../src/common/errors/app-error.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { buildCatalogContext } from "../../src/modules/extraction/catalog-context.js";
import type {
  ExtractedItem,
  ExtractionOutput,
} from "../../src/modules/extraction/extraction.schemas.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import {
  createIngestionService,
  type StoredExtraction,
} from "../../src/modules/extraction/ingestion.service.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import { createReviewRepository } from "../../src/modules/reviews/review.repository.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Catalog ingest + human review against Postgres (phase 5 M4). Runs are created directly
 * in `extracted` state with a given extraction ($0, no LLM) except the gate tests, which
 * go through the extraction service with the fake provider.
 */

const log = pino({ level: "silent" });
const system = { type: "system" as const };
const INJECTION = readFileSync(
  new URL("../fixtures/extraction/injection-message.txt", import.meta.url),
  "utf8",
);

const item = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  name: "Silicona 280ml",
  sku: null,
  unit: "unidad",
  price: "300",
  priceChangePct: null,
  currency: null,
  available: null,
  stock: null,
  catalogRef: null,
  matchConfidence: "high",
  uncertain: false,
  note: null,
  ...overrides,
});

const output = (overrides: Partial<ExtractionOutput> = {}): ExtractionOutput => ({
  isPriceList: true,
  listKind: "partial_update",
  fullListEvidence: null,
  supplierName: "Ferretería Norte S.A.",
  currency: "UYU",
  validFrom: null,
  taxIncluded: null,
  globalChangePct: null,
  items: [item()],
  warnings: [],
  suspiciousInstructions: false,
  ...overrides,
});

describe.skipIf(!testDatabaseUrl)("catalog ingest + human review (Postgres)", () => {
  let prisma: PrismaClient;
  let clock = Date.parse("2026-10-01T10:00:00Z");

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE review_items, alerts, price_changes, ai_usages, ingestion_runs, products, suppliers, settings, audit_logs CASCADE",
    );
  });

  function services(provider?: LlmProvider) {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const ingest = createCatalogIngestService({
      repository: createCatalogRepository(prisma),
      settings,
    });
    const reviews = createReviewService({
      repository: createReviewRepository(prisma),
      ingest,
      settings,
    });
    const extraction = createIngestionService({
      repository: createIngestionRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      ai: createAiClient({
        provider: provider ?? createFakeLlmProvider({ responders: FAKE_RESPONDERS }),
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
    return { ingest, reviews, extraction };
  }

  async function newContact(
    data: { name?: string | null; waId?: string; supplierId?: string } = {},
  ) {
    const contact = await prisma.contact.create({
      data: {
        waId: data.waId ?? `59899${Math.floor(Math.random() * 1e6)}`,
        name: data.name === undefined ? "Juan Proveedor" : data.name,
        ...(data.supplierId ? { supplierId: data.supplierId, kind: "supplier" } : {}),
      },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    return { contact, conversation };
  }

  /** A run already extracted with `out` (refs computed from the contact's current catalog). */
  async function extractedRun(out: ExtractionOutput, conversationId: string) {
    clock += 60_000;
    const message = await prisma.message.create({
      data: {
        conversationId,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "lista",
        waTimestamp: new Date(clock),
      },
    });
    const conv = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contact: { select: { supplierId: true } } },
    });
    const catalog = conv.contact.supplierId
      ? await prisma.product.findMany({ where: { supplierId: conv.contact.supplierId } })
      : [];
    const ctx = buildCatalogContext(catalog.map((p) => ({ ...p, price: p.price.toString() })));
    const stored: StoredExtraction = {
      output: out,
      refs: Object.fromEntries(ctx.refs),
      byNormalizedName: Object.fromEntries(ctx.byNormalizedName),
      catalogTruncated: ctx.truncated,
      promptVersion: "extractor@test",
    };
    return prisma.ingestionRun.create({
      data: {
        messageId: message.id,
        supplierId: conv.contact.supplierId,
        status: "extracted",
        classification: "price_update_partial",
        rawExtraction: stored as never,
      },
    });
  }

  const refOf = async (supplierId: string, name: string) => {
    const products = await prisma.product.findMany({ where: { supplierId } });
    const ctx = buildCatalogContext(products.map((p) => ({ ...p, price: p.price.toString() })));
    return [...ctx.refNames].find(([, n]) => n === name)?.[0] ?? null;
  };

  const price = async (supplierId: string, name: string) =>
    (await prisma.product.findFirstOrThrow({ where: { supplierId, name } })).price.toFixed();

  /** Supplier with Silicona 280ml @280 and Clavo 2 pulgadas @10 (first list). */
  async function seededSupplier(extra: Partial<ExtractionOutput> = {}) {
    const { contact, conversation } = await newContact();
    const run = await extractedRun(
      output({
        items: [item({ price: "280" }), item({ name: "Clavo 2 pulgadas", price: "10" })],
        ...extra,
      }),
      conversation.id,
    );
    const result = await services().ingest.ingest(run.id, log);
    return { contact, conversation, supplierId: result.supplierId!, firstRun: run };
  }

  // ─── Supplier resolution ───

  it("first list of a new contact: creates the supplier, links the contact, creates the products", async () => {
    const { contact, conversation } = await newContact();
    const run = await extractedRun(
      output({
        taxIncluded: true,
        items: [item(), item({ name: "Clavo 2 pulgadas", price: "10" })],
      }),
      conversation.id,
    );
    const result = await services().ingest.ingest(run.id, log);

    expect(result).toMatchObject({
      status: "ingested",
      pendingReviews: 0,
      counts: { created: 2, updated: 0, review: 0 },
    });
    expect(result.warnings.map((w) => w.code)).toEqual(["supplier_created"]);
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: result.supplierId! } });
    expect(supplier).toMatchObject({
      name: "Ferretería Norte S.A.",
      normalizedName: "ferreteria norte",
      taxIncluded: true,
    });
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({
      supplierId: supplier.id,
      kind: "supplier",
    });
    const changes = await prisma.priceChange.findMany({ orderBy: { createdAt: "asc" } });
    expect(changes.map((c) => [c.oldPrice, c.newPrice.toFixed(), c.source])).toEqual([
      [null, "300", "auto"],
      [null, "10", "auto"],
    ]);
    const products = await prisma.product.findMany();
    expect(products.every((p) => p.priceSourceAt?.getTime() === clock)).toBe(true);
    const runRow = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runRow).toMatchObject({ status: "ingested", supplierId: supplier.id });
  });

  it("links to an existing supplier whose normalized name matches the document", async () => {
    const existing = await prisma.supplier.create({
      data: { name: "FERRETERIA NORTE SA", normalizedName: "ferreteria norte" },
    });
    const { conversation } = await newContact();
    const result = await services().ingest.ingest(
      (await extractedRun(output(), conversation.id)).id,
      log,
    );
    expect(result.supplierId).toBe(existing.id);
    expect(result.warnings.map((w) => w.code)).toEqual(["supplier_linked"]);
    expect(await prisma.supplier.count()).toBe(1);
  });

  it("no supplier name in the document: uses the WhatsApp profile name, else a masked phone", async () => {
    const named = await newContact({ name: "Pedro Pérez" });
    const r1 = await services().ingest.ingest(
      (await extractedRun(output({ supplierName: null }), named.conversation.id)).id,
      log,
    );
    const anonymous = await newContact({ name: null, waId: "59899123160" });
    const r2 = await services().ingest.ingest(
      (await extractedRun(output({ supplierName: null }), anonymous.conversation.id)).id,
      log,
    );
    const names = await prisma.supplier.findMany({
      where: { id: { in: [r1.supplierId!, r2.supplierId!] } },
    });
    expect(names.map((s) => s.name).sort()).toEqual(["Pedro Pérez", "Proveedor 598*****160"]);
  });

  it("ambiguous supplier name → unknown_supplier gate; approving with a supplier links and ingests", async () => {
    const a = await prisma.supplier.create({
      data: { name: "Norte S.A.", normalizedName: "norte" },
    });
    await prisma.supplier.create({ data: { name: "NORTE", normalizedName: "norte" } });
    const { contact, conversation } = await newContact();
    const run = await extractedRun(output({ supplierName: "Norte" }), conversation.id);
    const svc = services();
    expect(await svc.ingest.ingest(run.id, log)).toMatchObject({
      status: "needs_review",
      gate: { kind: "unknown_supplier" },
    });
    await expect(svc.ingest.ingest(run.id, log)).rejects.toMatchObject({ code: "CONFLICT" });

    const [gate] = await svc.reviews.list({ ingestionRunId: run.id, status: "pending" });
    expect(gate).toMatchObject({ scope: "run", kind: "unknown_supplier" });
    const approved = await svc.reviews.approve(gate!.id, { supplierId: a.id }, system, log);
    expect(approved.ingest).toMatchObject({ status: "ingested", supplierId: a.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).supplierId).toBe(
      a.id,
    );
  });

  // ─── Idempotency & concurrency ───

  it("ingesting twice returns the stored report; concurrent ingests apply once", async () => {
    const { conversation } = await newContact();
    const run = await extractedRun(output(), conversation.id);
    const svc = services();
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4].map(() => svc.ingest.ingest(run.id, log)),
    );
    for (const o of outcomes.filter((x) => x.status === "rejected"))
      expect((o as PromiseRejectedResult).reason).toMatchObject({ code: "IN_PROGRESS" });
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.priceChange.count()).toBe(1);
    const again = await svc.ingest.ingest(run.id, log);
    expect(again).toMatchObject({ status: "ingested", counts: { created: 1 } });
    expect(await prisma.priceChange.count()).toBe(1);
  });

  it("a run that is not extracted yet is refused", async () => {
    const { conversation } = await newContact();
    const run = await extractedRun(output(), conversation.id);
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "classified" } });
    const err = await services()
      .ingest.ingest(run.id, log)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "NOT_READY" });
  });

  // ─── Prices, alerts, settings ───

  it("updates prices with PriceChange + alerts, and reads limits from settings", async () => {
    const { conversation, supplierId } = await seededSupplier();
    await prisma.setting.create({ data: { key: "catalog.maxIncreasePct", value: 30 } });
    const run = await extractedRun(
      output({
        items: [item({ price: "308" }), item({ name: "Clavo 2 pulgadas", price: "14" })],
      }),
      conversation.id,
    );
    const result = await services().ingest.ingest(run.id, log);
    expect(result.counts).toMatchObject({ updated: 1, review: 1, alerts: 1 });
    expect(await price(supplierId, "Silicona 280ml")).toBe("308"); // +10 %
    expect(await price(supplierId, "Clavo 2 pulgadas")).toBe("10"); // +40 % > 30 % → review
    const [review] = await prisma.reviewItem.findMany({ where: { ingestionRunId: run.id } });
    expect(review).toMatchObject({ kind: "price_outlier", scope: "line", status: "pending" });
    expect(review?.basePrice?.toFixed()).toBe("10");
    const change = await prisma.priceChange.findFirstOrThrow({ where: { ingestionRunId: run.id } });
    expect(change.changePct?.toFixed()).toBe("10");
    expect(await prisma.alert.count({ where: { type: "price_change" } })).toBe(1);
  });

  it("percentage changes use the current price (Decimal, rounding rule)", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const ref = await refOf(supplierId, "Silicona 280ml");
    const run = await extractedRun(
      output({ items: [item({ price: null, priceChangePct: "7.5", catalogRef: ref })] }),
      conversation.id,
    );
    await services().ingest.ingest(run.id, log);
    expect(await price(supplierId, "Silicona 280ml")).toBe("301");
  });

  // ─── Human review ───

  it("approving a product_match applies the change (source review) once, with an audit row", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const ref = await refOf(supplierId, "Clavo 2 pulgadas");
    const run = await extractedRun(
      output({
        items: [item({ name: "Clavos", price: "11", catalogRef: ref, matchConfidence: "medium" })],
      }),
      conversation.id,
    );
    const svc = services();
    await svc.ingest.ingest(run.id, log);
    const [review] = await svc.reviews.list({ ingestionRunId: run.id });
    expect(review).toMatchObject({ kind: "product_match", status: "pending" });

    const approved = await svc.reviews.approve(review!.id, {}, system, log);
    expect(approved.resolution).toMatchObject({ created: false, price: "11", changed: true });
    expect(await price(supplierId, "Clavo 2 pulgadas")).toBe("11");
    const change = await prisma.priceChange.findFirstOrThrow({
      where: { reviewItemId: review!.id },
    });
    expect(change).toMatchObject({ source: "review", ingestionRunId: run.id });
    expect(await prisma.auditLog.findFirstOrThrow()).toMatchObject({
      action: "review.approve",
      entity: "review_item",
      entityId: review!.id,
      actorType: "system",
    });
    await expect(svc.reviews.approve(review!.id, {}, system, log)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("approve can create a new product instead, with an edited price; reject changes nothing", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const run = await extractedRun(
      output({
        items: [
          item({ name: "Rodillo lana 23cm", price: "400", matchConfidence: "low" }),
          item({ name: "Disco de corte", price: "95", matchConfidence: "low" }),
        ],
      }),
      conversation.id,
    );
    const svc = services();
    await svc.ingest.ingest(run.id, log);
    const [first, second] = await svc.reviews.list({ ingestionRunId: run.id });
    await svc.reviews.approve(first!.id, { createNew: true, price: "410" }, system, log);
    expect(await price(supplierId, "Rodillo lana 23cm")).toBe("410");
    await svc.reviews.reject(second!.id, { note: "no lo vendemos" }, system, log);
    expect(await prisma.product.count({ where: { name: "Disco de corte" } })).toBe(0);
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe(
      "rejected",
    );
  });

  it("a stale proposal is superseded (409 STALE_REVIEW); newer runs supersede older pending items", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const svc = services();
    const outlier = await extractedRun(
      output({ items: [item({ name: "Clavo 2 pulgadas", price: "30" })] }),
      conversation.id,
    );
    await svc.ingest.ingest(outlier.id, log);
    const [pending] = await svc.reviews.list({ ingestionRunId: outlier.id });
    await prisma.product.updateMany({ where: { name: "Clavo 2 pulgadas" }, data: { price: 12 } });
    await expect(svc.reviews.approve(pending!.id, {}, system, log)).rejects.toMatchObject({
      code: "STALE_REVIEW",
      statusCode: 409,
    });
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: pending!.id } })).status).toBe(
      "superseded",
    );

    const second = await extractedRun(
      output({ items: [item({ name: "Clavo 2 pulgadas", price: "40" })] }),
      conversation.id,
    );
    await svc.ingest.ingest(second.id, log);
    const third = await extractedRun(
      output({ items: [item({ name: "Clavo 2 pulgadas", price: "13" })] }),
      conversation.id,
    );
    await svc.ingest.ingest(third.id, log);
    expect(await price(supplierId, "Clavo 2 pulgadas")).toBe("13");
    const [older] = await svc.reviews.list({ ingestionRunId: second.id });
    expect(older?.status).toBe("superseded");
  });

  it("tax basis change gates the run; approving applies it and stores the new basis", async () => {
    const { conversation, supplierId } = await seededSupplier({ taxIncluded: true });
    const svc = services();
    const run = await extractedRun(
      output({ taxIncluded: false, items: [item({ price: "250" })] }),
      conversation.id,
    );
    expect(await svc.ingest.ingest(run.id, log)).toMatchObject({
      status: "needs_review",
      gate: { kind: "tax_basis_changed" },
    });
    expect(await price(supplierId, "Silicona 280ml")).toBe("280");
    const [gate] = await svc.reviews.list({ ingestionRunId: run.id });
    const approved = await svc.reviews.approve(gate!.id, {}, system, log);
    expect(approved.ingest).toMatchObject({ status: "ingested", counts: { updated: 1 } });
    expect(await price(supplierId, "Silicona 280ml")).toBe("250");
    expect(
      (await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).taxIncluded,
    ).toBe(false);

    const other = await extractedRun(
      output({ taxIncluded: true, items: [item({ price: "260" })] }),
      conversation.id,
    );
    await svc.ingest.ingest(other.id, log);
    const [otherGate] = await svc.reviews.list({ ingestionRunId: other.id });
    await svc.reviews.reject(otherGate!.id, {}, system, log);
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      "rejected",
    );
    expect(await price(supplierId, "Silicona 280ml")).toBe("250");
  });

  it("full list: missing products become mark_unavailable items, applied only on approval", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const svc = services();
    const run = await extractedRun(
      output({
        listKind: "full_list",
        fullListEvidence: "Lista completa",
        items: [item({ price: "280" })],
      }),
      conversation.id,
    );
    await svc.ingest.ingest(run.id, log);
    const [candidate] = await svc.reviews.list({ ingestionRunId: run.id });
    expect(candidate).toMatchObject({
      kind: "mark_unavailable",
      scope: "catalog",
      reasons: ["missing_from_full_list"],
    });
    const clavo = await prisma.product.findFirstOrThrow({
      where: { supplierId, name: "Clavo 2 pulgadas" },
    });
    expect(clavo.available).toBe(true);
    await svc.reviews.approve(candidate!.id, {}, system, log);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: clavo.id } })).available).toBe(
      false,
    );
  });

  it("global percentage: always a review; approval applies it where the price did not change", async () => {
    const { conversation, supplierId } = await seededSupplier();
    const svc = services();
    const run = await extractedRun(output({ items: [], globalChangePct: "10" }), conversation.id);
    expect((await svc.ingest.ingest(run.id, log)).counts).toMatchObject({ globalChange: true });
    expect(await price(supplierId, "Silicona 280ml")).toBe("280");
    const [global] = await svc.reviews.list({ ingestionRunId: run.id });
    expect(global?.kind).toBe("global_change");
    await prisma.product.updateMany({ where: { name: "Clavo 2 pulgadas" }, data: { price: 11 } });
    const approved = await svc.reviews.approve(global!.id, {}, system, log);
    expect((approved.resolution.applied as string[]).length).toBe(1);
    expect((approved.resolution.skipped as string[]).length).toBe(1);
    expect(await price(supplierId, "Silicona 280ml")).toBe("308");
    expect(await price(supplierId, "Clavo 2 pulgadas")).toBe("11");
  });

  // ─── Gates created by the extraction (M2 runs) ───

  it("suspicious instructions → gate; approving ingests with every line in review", async () => {
    const { conversation } = await newContact();
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: INJECTION,
      },
    });
    const svc = services();
    const { runId } = await svc.extraction.classify(message.id, log);
    expect(await svc.extraction.extract(runId, log)).toMatchObject({ status: "needs_review" });
    const [gate] = await svc.reviews.list({ ingestionRunId: runId });
    expect(gate).toMatchObject({ scope: "run", kind: "suspicious_instructions" });

    const approved = await svc.reviews.approve(gate!.id, {}, system, log);
    expect(approved.ingest).toMatchObject({
      status: "ingested",
      counts: { created: 0, review: 1 },
    });
    const lines = await svc.reviews.list({ ingestionRunId: runId, status: "pending" });
    expect(lines[0]?.reasons).toContain("suspicious_source");
  });

  it("an AI failure → extraction_failed gate; approving sends the run back to be classified", async () => {
    const { conversation } = await newContact();
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "Silicona 300 UYU",
      },
    });
    const refusing: LlmProvider = {
      name: "fake",
      generateStructured: async <T>(req: StructuredRequest<T>) => {
        const { LlmError } = await import("../../src/ai/llm-provider.js");
        throw new LlmError("invalid_output", false, `no output (${req.task})`);
      },
    };
    const svc = services(refusing);
    const { runId, status } = await svc.extraction.classify(message.id, log);
    expect(status).toBe("needs_review");
    const [gate] = await svc.reviews.list({ ingestionRunId: runId });
    expect(gate).toMatchObject({ kind: "extraction_failed", reasons: ["llm_invalid_output"] });
    const approved = await svc.reviews.approve(gate!.id, {}, system, log);
    expect(approved.resolution).toMatchObject({ retry: "classify", runStatus: "pending" });
    expect(await services().extraction.classify(message.id, log)).toMatchObject({
      runId,
      status: "classified",
    });
  });
});
