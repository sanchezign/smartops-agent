import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import type { PrismaClient } from "../../common/db.js";
import type { Logger } from "../../common/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { hashPassword } from "../auth/password.js";
import type { CatalogIngestService } from "../catalog/catalog-ingest.service.js";
import { renderDigest, type ItemData } from "../notifications/digest-rules.js";
import { demoListPng } from "./demo-image.js";
import { normalizeProductName } from "../catalog/normalize.js";
import { normalizeSupplierName } from "../catalog/supplier-name.js";
import { convertDocument } from "../documents/convert.js";
import { CONVERTER_VERSION } from "../documents/document-conversion.service.js";
import { cellText, DEFAULT_CONVERSION_LIMITS } from "../documents/document-types.js";
import {
  headerCandidates,
  sheetPreview,
  type ColumnMappingProposal,
} from "../sheets/sheet-extraction.js";
import { choosePriceColumn, normalizeMapperTable } from "../sheets/sheet-mapping.js";
import { saveSheetFormatInTx } from "../sheets/sheet-format.repository.js";
import { headerFingerprint } from "../sheets/sheet-values.js";
import type { ExtractionOutput } from "../extraction/extraction.schemas.js";
import type { StoredExtraction } from "../extraction/ingestion.service.js";
import { getDemoContent, type DemoContent } from "./content/index.js";
import type { DemoSupplier } from "./content/types.js";

/**
 * Demo seed (phase 9): wipes a DEMO database and fills it with 90 days of realistic activity.
 * Price lists go through the REAL catalog ingest (runs with a stored extraction → products,
 * price changes, alerts and review items exactly as in production), then their timestamps are
 * moved back to the message date. Deterministic (fixed PRNG seed), relative to `now`.
 * Refuses to run on any database whose name does not end in "_demo".
 */

export const DEMO_DATABASE_SUFFIX = "_demo";

export class NotADemoDatabaseError extends Error {
  constructor(name: string) {
    super(
      `refusing to seed "${name}": the demo database name must end in "${DEMO_DATABASE_SUFFIX}"`,
    );
    this.name = "NotADemoDatabaseError";
  }
}

export function assertDemoDatabaseName(name: string): void {
  if (!name.endsWith(DEMO_DATABASE_SUFFIX)) throw new NotADemoDatabaseError(name);
}

/** mulberry32: tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/**
 * Stable ids for what the seed itself creates (suppliers, contacts, conversations): a chat or
 * link open on a phone survives the automatic reset (phase 9 phone tests). Rows created by
 * the REAL ingest (products, price changes, reviews) keep random ids — the panel shows
 * "Esto ya no existe" for those after a reset.
 */
export function demoUuid(key: string): string {
  const h = createHash("sha256").update(`smartops-demo:${key}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface DemoUser {
  email: string;
  password: string;
  name: string;
}

export interface DemoUsers {
  operator: DemoUser;
  admin?: DemoUser;
}

export interface SeedResult {
  suppliers: number;
  products: number;
  priceChanges: number;
  reviewItems: number;
  messages: number;
}

export async function seedDemo(deps: {
  prisma: PrismaClient;
  catalog: CatalogIngestService;
  users: DemoUsers;
  logger: Logger;
  now?: Date;
  /**
   * "Reiniciar demo" / automatic reset (phase 9 M8): keep users, sessions and refresh tokens
   * (visitors stay logged in); the demo users get their public password back.
   */
  keepAuth?: boolean;
  /** Demo assets (recorded outputs, sample files): the sample senders' catalogs. */
  assetsDir?: string;
  /** E2E only: one review per Playwright project to approve and one to reject. */
  e2eReviews?: boolean;
  /** The demo content (ADR-031); the Spanish one when omitted. */
  content?: DemoContent;
}): Promise<SeedResult> {
  const { prisma, logger } = deps;
  const content = deps.content ?? getDemoContent("es");
  const { suppliers: DEMO_SUPPLIERS, customers: DEMO_CUSTOMERS } = content;
  const now = deps.now ?? new Date();
  const [database] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  assertDemoDatabaseName(database?.name ?? "");

  const rand = prng(42);
  const at = (daysAgo: number, hour = 10) =>
    new Date(
      now.getTime() - daysAgo * DAY + (hour - 12) * 3_600_000 + Math.floor(rand() * 3_600_000),
    );

  // ── Wipe every app table (never the migrations table) ──────────────────────
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const kept = deps.keepAuth
    ? new Set(["users", "auth_sessions", "refresh_tokens"])
    : new Set<string>();
  const wiped = tables.filter((t) => !kept.has(t.tablename));
  if (wiped.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${wiped.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  }
  if (deps.keepAuth) {
    // Every visitor logs in as the same public operator (phase 12): sessions would pile up
    // forever across resets. Live sessions stay (visitors keep their login); ended ones go,
    // with their refresh tokens (ON DELETE CASCADE).
    await prisma.authSession.deleteMany({
      where: {
        OR: [
          { revokedAt: { not: null } },
          { expiresAt: { lte: now } },
          { idleExpiresAt: { lte: now } },
        ],
      },
    });
  }

  // ── Settings for a lively demo (never a real WhatsApp recipient) ───────────
  await prisma.setting.createMany({
    data: [
      { key: "catalog.lowStockThreshold", value: 10 },
      { key: "notifications.whatsappRecipients", value: [] },
      { key: "bot.supplierAck", value: true },
      // Spanish is the default of `business.language`: only another language is stored (the
      // Spanish seed stays exactly as it always was).
      ...(content.language !== "es" ? [{ key: "business.language", value: content.language }] : []),
    ],
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  // Upsert: a reset keeps the accounts (and their sessions) but restores the public password
  // and the role, and clears any lockout a visitor may have caused.
  const upsertUser = async (u: DemoUser, role: "admin" | "operator") => {
    const data = {
      name: u.name,
      role,
      active: true,
      passwordHash: await hashPassword(u.password),
      passwordChangedAt: now,
      failedLoginCount: 0,
      loginWindowStartedAt: null,
      lockedUntil: null,
      lockLevel: 0,
    };
    return prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, ...data },
      update: data,
    });
  };
  const operator = await upsertUser(deps.users.operator, "operator");
  if (deps.users.admin) await upsertUser(deps.users.admin, "admin");
  if (deps.keepAuth) {
    // A demo operator that is no longer THE public one (its credentials changed, phase 14: the old
    // address and password are still published in old READMEs, videos and screenshots) must not
    // keep working: deactivated and logged out. Only operators: an admin created by hand in the
    // demo database is never touched.
    const current = [deps.users.operator.email, deps.users.admin?.email].filter(
      (e): e is string => !!e,
    );
    const stale = await prisma.user.findMany({
      where: { role: "operator", active: true, email: { notIn: current } },
      select: { id: true },
    });
    if (stale.length > 0) {
      const ids = stale.map((u) => u.id);
      await prisma.user.updateMany({ where: { id: { in: ids } }, data: { active: false } });
      await prisma.authSession.updateMany({
        where: { userId: { in: ids }, revokedAt: null },
        data: { revokedAt: now, revokeReason: "user_deactivated" },
      });
      logger.info(
        { retired: stale.length },
        "retired demo operators that are no longer the public one",
      );
    }
  }

  let waSeq = 0;
  const wamid = () => `wamid.DEMO${String(++waSeq).padStart(8, "0")}`;
  let messages = 0;

  async function conversationFor(
    waId: string,
    name: string,
    kind: "supplier" | "customer" | "internal",
    supplierId?: string,
  ) {
    const contact = await prisma.contact.create({
      data: {
        id: demoUuid(`contact:${waId}`),
        waId,
        name,
        kind,
        supplierId: supplierId ?? null,
        optInAt: at(95),
        optInSource: "inbound",
      },
    });
    const conversation = await prisma.conversation.create({
      data: { id: demoUuid(`conversation:${waId}`), contactId: contact.id },
    });
    return { contactId: contact.id, conversationId: conversation.id };
  }

  async function inbound(conversationId: string, text: string, when: Date, type: "text" = "text") {
    messages += 1;
    const message = await prisma.message.create({
      data: {
        conversationId,
        waMessageId: wamid(),
        direction: "inbound",
        type,
        author: "contact",
        text,
        waTimestamp: when,
        createdAt: when,
      },
    });
    await prisma.$executeRaw`
      UPDATE conversations
         SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${when}::timestamptz), ${when}::timestamptz),
             last_message_at = GREATEST(COALESCE(last_message_at, ${when}::timestamptz), ${when}::timestamptz)
       WHERE id = ${conversationId}::uuid`;
    return message;
  }

  async function outbound(
    conversationId: string,
    text: string,
    when: Date,
    author: "bot" | "human",
    purpose: "auto_reply" | "human" | "compliance",
    status: "read" | "delivered" | "sent" | "canceled" = "read",
  ) {
    messages += 1;
    await prisma.message.create({
      data: {
        conversationId,
        waMessageId: status === "canceled" ? null : wamid(),
        direction: "outbound",
        type: "text",
        author,
        purpose,
        text,
        status,
        statusAt: when,
        ...(author === "human" ? { authorUserId: operator.id } : {}),
        ...(status === "canceled" ? { errorCode: "human_takeover" } : {}),
        createdAt: when,
      },
    });
    await prisma.$executeRaw`
      UPDATE conversations
         SET last_message_at = GREATEST(COALESCE(last_message_at, ${when}::timestamptz), ${when}::timestamptz)
       WHERE id = ${conversationId}::uuid`;
  }

  async function aiUsage(
    task: "classify" | "extract",
    when: Date,
    runId: string | null,
    contactId: string,
  ) {
    const extract = task === "extract";
    // Classify: the ~1,050-token prompt + the message; the output includes the short reasoning of
    // effort "low" (thinking tokens bill as output, ADR-011).
    const input = extract ? 900 + Math.floor(rand() * 1200) : 1080 + Math.floor(rand() * 420);
    const output = extract ? 300 + Math.floor(rand() * 700) : 60 + Math.floor(rand() * 110);
    const cacheRead = extract ? 4392 : 0;
    // Sonnet 5: $2 / $10 per MTok, cache read 0.1x (ADR-011).
    const usd = (input * 2 + output * 10 + cacheRead * 0.2) / 1_000_000;
    await prisma.aiUsage.create({
      data: {
        task,
        status: "ok",
        provider: "anthropic",
        model: "claude-sonnet-5",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        costUsd: new Prisma.Decimal(usd.toFixed(6)),
        latencyMs: extract ? 4000 + Math.floor(rand() * 6000) : 700 + Math.floor(rand() * 500),
        ingestionRunId: runId,
        contactId,
        createdAt: when,
      },
    });
  }

  // ── Suppliers: 90 days of lists through the REAL catalog ingest ────────────
  const currentPrices = new Map<string, Map<string, number>>();
  let reviewItems = 0;
  let priceChanges = 0;

  async function ingestList(
    supplier: DemoSupplier,
    ids: { contactId: string; conversationId: string; supplierId: string },
    when: Date,
    text: string,
    output: ExtractionOutput,
    options: { suspicious?: boolean } = {},
  ) {
    const message = await inbound(ids.conversationId, text, when);
    const found = await prisma.product.findMany({
      where: { supplierId: ids.supplierId },
      select: { id: true, normalizedName: true },
      orderBy: { createdAt: "asc" },
    });
    // P1, P2… follow the order the supplier's catalog is DECLARED in demo-data (so "P4" is always
    // the same product). The products of one list are created in the same millisecond: sorting by
    // createdAt alone left their order to the database, and the seed was not deterministic
    // (found with the seed fingerprint, phase 14 M5a). Products not declared keep their order.
    const declared = new Map(supplier.products.map((p, i) => [normalizeProductName(p.name), i]));
    const products = [...found].sort(
      (x, y) =>
        (declared.get(x.normalizedName) ?? Infinity) - (declared.get(y.normalizedName) ?? Infinity),
    );
    const refs: Record<string, string> = {};
    products.forEach((p, i) => (refs[`P${i + 1}`] = p.id));
    const stored: StoredExtraction = {
      output,
      refs,
      byNormalizedName: Object.fromEntries(products.map((p) => [p.normalizedName, p.id])),
      catalogTruncated: false,
      promptVersion: "extractor@demo",
    };
    const run = await prisma.ingestionRun.create({
      data: {
        messageId: message.id,
        supplierId: ids.supplierId,
        classification:
          output.listKind === "full_list" ? "price_list_full" : "price_update_partial",
        status: "extracted",
        rawExtraction: stored as unknown as Prisma.InputJsonValue,
        model: "claude-sonnet-5",
        promptVersion: "extractor@demo",
        createdAt: when,
      },
    });
    await aiUsage("classify", when, run.id, ids.contactId);
    await aiUsage("extract", new Date(when.getTime() + 5000), run.id, ids.contactId);
    if (options.suspicious) {
      // Same gate the extraction creates (ingestion.repository createReviewGate): the list
      // never reaches the catalog until a person decides.
      const detail = content.text.suspiciousDetail;
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: "needs_review",
          errors: { reason: "suspicious_instructions", detail },
          finishedAt: new Date(when.getTime() + 9000),
        },
      });
      await prisma.reviewItem.create({
        data: {
          ingestionRunId: run.id,
          supplierId: ids.supplierId,
          scope: "run",
          kind: "suspicious_instructions",
          dedupeKey: "gate:suspicious_instructions:1",
          reasons: ["suspicious_instructions"],
          proposal: { task: "extract", reason: "suspicious_instructions", detail },
          createdAt: when,
          updatedAt: when,
        },
      });
      reviewItems += 1;
      return run;
    }
    await deps.catalog.ingest(run.id, logger);
    // Move what the ingest created back to the message date (history charts, queues).
    await prisma.$executeRaw`UPDATE price_changes SET created_at = ${when} WHERE ingestion_run_id = ${run.id}::uuid`;
    await prisma.$executeRaw`UPDATE alerts SET created_at = ${when}, updated_at = ${when} WHERE ingestion_run_id = ${run.id}::uuid`;
    await prisma.$executeRaw`UPDATE review_items SET created_at = ${when}, updated_at = ${when} WHERE ingestion_run_id = ${run.id}::uuid`;
    await prisma.$executeRaw`UPDATE ingestion_runs SET finished_at = ${new Date(when.getTime() + 9000)} WHERE id = ${run.id}::uuid AND finished_at IS NOT NULL`;
    priceChanges += await prisma.priceChange.count({ where: { ingestionRunId: run.id } });
    reviewItems += await prisma.reviewItem.count({ where: { ingestionRunId: run.id } });
    return run;
  }

  // Items and lists default to the content's catalog currency; a supplier that quotes in another
  // one (Norvale in CAD, phase 14 M5c) says so in `supplier.currency` and the list follows it.
  const item = (
    name: string,
    price: number,
    extra: Partial<ExtractionOutput["items"][number]> = {},
    currency = content.currency,
  ) => ({
    name,
    sku: null,
    unit: null,
    price: price.toFixed(2),
    priceChangePct: null,
    currency,
    available: null,
    stock: null,
    catalogRef: null,
    matchConfidence: "high" as const,
    uncertain: false,
    note: null,
    ...extra,
  });
  const list = (
    supplier: DemoSupplier,
    items: ExtractionOutput["items"],
    extra: Partial<ExtractionOutput> = {},
  ): ExtractionOutput => ({
    isPriceList: true,
    listKind: "partial_update",
    fullListEvidence: null,
    supplierName: supplier.name,
    currency: supplier.currency,
    validFrom: null,
    taxIncluded: supplier.taxIncluded,
    globalChangePct: null,
    items,
    warnings: [],
    suspiciousInstructions: false,
    ...extra,
  });

  for (const [index, supplier] of DEMO_SUPPLIERS.entries()) {
    const dbSupplier = await prisma.supplier.create({
      data: {
        id: demoUuid(`supplier:${supplier.name}`),
        name: supplier.name,
        normalizedName: normalizeSupplierName(supplier.name),
        taxIncluded: supplier.taxIncluded,
        taxIncludedAt: at(90),
      },
    });
    const ids = {
      ...(await conversationFor(supplier.waId, supplier.contactName, "supplier", dbSupplier.id)),
      supplierId: dbSupplier.id,
    };
    const prices = new Map(supplier.products.map((p) => [p.name, p.price * 0.9]));
    currentPrices.set(supplier.key, prices);

    // Day -90: the full list (stock included).
    await ingestList(
      supplier,
      ids,
      at(90 - index, 9),
      content.text.fullListMessage(supplier.name),
      list(
        supplier,
        supplier.products.map((p) =>
          item(
            p.name,
            round2(prices.get(p.name)!),
            { unit: p.unit, stock: p.stock ?? null },
            supplier.currency,
          ),
        ),
        { listKind: "full_list", fullListEvidence: content.text.fullListEvidence },
      ),
    );

    // Every ~10 days: a partial update with small increases (inflation-like).
    for (let daysAgo = 80 - index * 2; daysAgo > 8; daysAgo -= 9 + Math.floor(rand() * 4)) {
      const picked = supplier.products.filter(() => rand() < 0.35);
      if (picked.length === 0) continue;
      const items = picked.map((p) => {
        const next = round2(prices.get(p.name)! * (1.015 + rand() * 0.045));
        prices.set(p.name, next);
        return item(p.name, next, {}, supplier.currency);
      });
      await ingestList(
        supplier,
        ids,
        at(daysAgo),
        content.text.updateMessage(items.length),
        list(supplier, items),
      );
      await outbound(
        ids.conversationId,
        content.text.thanksReply(items.length),
        at(daysAgo, 11),
        "bot",
        "auto_reply",
      );
    }
  }

  // Recent lists that need a person (the review queue of the demo).
  const [norte, sur, oriental] = DEMO_SUPPLIERS;
  const story = content.story;
  const idsOf = async (supplier: DemoSupplier) => {
    const contact = await prisma.contact.findUniqueOrThrow({
      where: { waId: supplier.waId },
      select: { id: true, supplierId: true, conversation: { select: { id: true } } },
    });
    return {
      contactId: contact.id,
      conversationId: contact.conversation!.id,
      supplierId: contact.supplierId!,
    };
  };
  const price = (supplier: DemoSupplier, name: string) =>
    currentPrices.get(supplier.key)!.get(name)!;

  // Norte, 5 days ago: increases incl. one over 10 % (alert) and an outlier (+85 % → review).
  await ingestList(
    norte,
    await idsOf(norte),
    at(5),
    story.increases.message,
    list(norte, [
      ...story.increases.rises.map((r) =>
        item(r.product, round2(price(norte, r.product) * r.factor), {}, norte.currency),
      ),
      item(
        story.increases.alias.name,
        round2(price(norte, story.increases.alias.product)),
        { catalogRef: story.increases.alias.ref, matchConfidence: "medium" },
        norte.currency,
      ),
    ]),
  );
  // Norte, 5 days ago: the photo of the printed list (chat media for the panel, ADR-019).
  {
    const ids = await idsOf(norte);
    const when = at(5, 9);
    const bytes = demoListPng();
    const media = await prisma.mediaFile.create({
      data: {
        waMediaId: "demo-media-norte-photo",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        status: "stored",
        storage: "postgres",
        downloadedAt: when,
        createdAt: when,
        blob: { create: { data: bytes } },
      },
    });
    messages += 1;
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        waMessageId: wamid(),
        direction: "inbound",
        type: "image",
        author: "contact",
        text: story.increases.photoCaption,
        mediaFileId: media.id,
        waTimestamp: when,
        createdAt: when,
      },
    });
  }
  // Sur, 3 days ago: a global +8 % and a doubtful value from a voice note.
  await ingestList(
    sur,
    await idsOf(sur),
    at(3),
    story.globalChange.message,
    list(
      sur,
      [
        item(
          story.globalChange.product,
          round2(price(sur, story.globalChange.product) * story.globalChange.factor),
          { uncertain: true, note: story.globalChange.note },
          sur.currency,
        ),
      ],
      { globalChangePct: story.globalChange.pct },
    ),
  );
  // Oriental, 4 days ago: a FULL list without "Zapatilla 5 tomas" → the planner asks a person
  // before marking it unavailable (mark_unavailable, missing_from_full_list).
  await ingestList(
    oriental,
    await idsOf(oriental),
    at(4),
    story.missingFromList.message,
    list(
      oriental,
      oriental.products
        .filter((p) => p.name !== story.missingFromList.product)
        .map((p) =>
          item(p.name, round2(price(oriental, p.name)), { unit: p.unit }, oriental.currency),
        ),
      { listKind: "full_list", fullListEvidence: story.missingFromList.evidence },
    ),
  );
  // Oriental, 2 days ago: one product quoted in USD (currency change) + a new product.
  await ingestList(
    oriental,
    await idsOf(oriental),
    at(2),
    story.currencyChange.message,
    list(
      oriental,
      [
        item(
          story.currencyChange.changed.name,
          story.currencyChange.changed.price,
          {},
          story.currencyChange.changed.currency,
        ),
        item(
          story.currencyChange.created.name,
          story.currencyChange.created.price,
          {},
          oriental.currency,
        ),
      ],
      { currency: null },
    ),
  );
  // Norte, a few hours ago: a spreadsheet in a format never approved, with four price columns →
  // column_mapping gate. Real xlsx bytes, converted by the production converter; the proposal
  // is built with the same functions the sheet extraction uses (only the mapper answer is
  // canned, like the fake LLM does).
  reviewItems += await seedColumnMappingReview(prisma, content, await idsOf(norte), at(0, 8));

  // Norte, yesterday: a message trying to give orders to the bot (prompt injection gate).
  await ingestList(
    norte,
    await idsOf(norte),
    at(1),
    story.injection.message,
    list(norte, [item(story.injection.product, story.injection.price, {}, norte.currency)], {
      suspiciousInstructions: true,
      warnings: [content.text.suspiciousDetail],
    }),
    { suspicious: true },
  );

  // ── "Probar el sistema" senders (phase 9 M8) ───────────────────────────────
  const assetsDir = deps.assetsDir ?? "demo";
  const assetFile = (name: string) => join(assetsDir, "assets", content.assetsSubdir, name);
  const sampleSenders = content.sampleSenders;
  const sampleSupplier = async (key: keyof typeof sampleSenders, taxIncluded: boolean | null) => {
    const sender = sampleSenders[key];
    const supplier = await prisma.supplier.create({
      data: {
        id: demoUuid(`supplier:${sender.supplierName}`),
        name: sender.supplierName,
        normalizedName: normalizeSupplierName(sender.supplierName),
        taxIncluded,
        taxIncludedAt: taxIncluded === null ? null : at(20),
      },
    });
    return {
      ...(await conversationFor(sender.waId, sender.contactName, "supplier", supplier.id)),
      supplierId: supplier.id,
    };
  };
  const asSupplier = (name: string, taxIncluded: boolean) =>
    ({
      key: name,
      name,
      waId: "",
      contactName: name,
      taxIncluded,
      currency: content.currency,
      products: [],
    }) as DemoSupplier;

  // Distribuidora Demo S.A.: the September PDF catalog, from its RECORDED extraction, so the
  // photo / voice note buttons (recorded against it) point at the right products.
  const pdfExtraction = readdirSync(join(assetsDir, "golden", "extract"))
    .map(
      (f) =>
        JSON.parse(
          readFileSync(join(assetsDir, "golden", "extract", f), "utf8"),
        ) as ExtractionOutput,
    )
    .find(
      (o) => o.listKind === "full_list" && o.supplierName === sampleSenders.catalog.supplierName,
    );
  if (!pdfExtraction)
    throw new Error(`demo assets: no recorded PDF extraction in ${assetsDir}/golden`);
  const demoIds = await sampleSupplier("catalog", true);
  await ingestList(
    asSupplier(sampleSenders.catalog.supplierName, true),
    demoIds,
    at(20),
    content.catalogListMessage,
    pdfExtraction,
  );

  // Distribuidora Ejemplo S.R.L.: November spreadsheet prices + its format ALREADY APPROVED
  // (user 2026-09-26): its next spreadsheet is read without AI.
  const ejemploIds = await sampleSupplier("known", true);
  const known = content.knownSender;
  await ingestList(
    asSupplier(sampleSenders.known.supplierName, true),
    ejemploIds,
    at(30),
    known.messageText,
    list(
      asSupplier(sampleSenders.known.supplierName, true),
      known.earlierList.map(([name, unit, p]) => item(name, p, { unit })),
      { listKind: "full_list", fullListEvidence: known.evidence },
    ),
  );
  {
    const bytes = new Uint8Array(readFileSync(assetFile(known.formatFile)));
    const converted = await convertDocument(
      { bytes, mimeType: XLSX_MIME, filename: "precios.xlsx" },
      DEFAULT_CONVERSION_LIMITS,
    );
    if (!converted.ok) throw new Error(`demo spreadsheet conversion failed: ${converted.reason}`);
    // The recorded mapper answer of THIS content's sheet: goldens of several languages share
    // the folder (their file names are hashes of the content).
    const mapperDir = join(assetsDir, "golden", "map_columns");
    const mapper = readdirSync(mapperDir)
      .map(
        (f) =>
          JSON.parse(readFileSync(join(mapperDir, f), "utf8")) as {
            supplierName: string | null;
            tables: Parameters<typeof normalizeMapperTable>[0][];
          },
      )
      .find((m) => m.supplierName === content.mapperGoldenSupplierName);
    if (!mapper) {
      throw new Error(
        `demo assets: no recorded column mapping for "${content.mapperGoldenSupplierName}"`,
      );
    }
    const answer = mapper.tables[0]!;
    const table = converted.tables[0]!;
    const header = table.rows[answer.headerRow]!;
    const { mapping } = normalizeMapperTable(answer, header.length);
    await prisma.$transaction((tx) =>
      saveSheetFormatInTx(tx, {
        supplierId: ejemploIds.supplierId,
        fingerprint: headerFingerprint(header)!,
        headerCells: header.map(cellText),
        sheetName: table.name,
        format: { isPriceTable: true, mapping: choosePriceColumn(mapping, 4) },
        approvedById: operator.id,
        reviewItemId: null,
      }),
    );
  }

  // Mayorista del Este: no approved format → its spreadsheet goes to the column review.
  await sampleSupplier("unknown", null);

  // E2E only (user, after M2): each Playwright project approves and rejects ITS OWN reviews.
  if (deps.e2eReviews) {
    for (const project of ["desktop", "pixel", "iphone"]) {
      const name = content.e2e.supplierName(project);
      const supplier = await prisma.supplier.create({
        data: {
          id: demoUuid(`supplier:${name}`),
          name,
          normalizedName: normalizeSupplierName(name),
          taxIncluded: true,
          taxIncludedAt: at(10),
        },
      });
      const ids = {
        ...(await conversationFor(
          content.e2e.waId(["desktop", "pixel", "iphone"].indexOf(project)),
          name,
          "supplier",
          supplier.id,
        )),
        supplierId: supplier.id,
      };
      const e2eSupplier = asSupplier(name, true);
      const products = content.e2e.products(project);
      await ingestList(
        e2eSupplier,
        ids,
        at(10),
        content.e2e.initialMessage,
        list(
          e2eSupplier,
          products.map((p) => item(p, 100)),
        ),
      );
      // +200 %: over the outlier limit → one line review each (resolvable by an operator).
      await ingestList(
        e2eSupplier,
        ids,
        at(1),
        content.e2e.raiseMessage,
        list(
          e2eSupplier,
          products.map((p) => item(p, 300)),
        ),
      );
    }
  }

  // ── Customers: queries and orders (deterministic pre-filter, no LLM) ───────
  const customerIds: { contactId: string; conversationId: string }[] = [];
  for (const customer of DEMO_CUSTOMERS) {
    customerIds.push(await conversationFor(customer.waId, customer.name, customer.kind));
  }
  const customerMessages: {
    who: number;
    kind: "query" | "order";
    messageId: string;
    text: string;
  }[] = [];
  for (const [who, text, kind, daysAgo] of content.customerMessages) {
    const ids = customerIds[who]!;
    const when = at(daysAgo, 15);
    const message = await inbound(ids.conversationId, text, when);
    customerMessages.push({ who, kind, messageId: message.id, text });
    await prisma.ingestionRun.create({
      data: {
        messageId: message.id,
        classification: kind === "order" ? "internal_order" : "customer_query",
        status: "classified",
        prefilterRule: "customer_contact",
        createdAt: when,
      },
    });
    await prisma.notificationItem.create({
      data: {
        recipient: "panel",
        category: kind === "order" ? "order" : "customer_query",
        dedupeKey: `${kind === "order" ? "order" : "customer_query"}:${message.id}`,
        title: content.text
          .itemTitle(kind === "order" ? "order" : "customer_query", DEMO_CUSTOMERS[who]!.name, text)
          .slice(0, 120),
        data: { category: kind === "order" ? "order" : "customer_query", messageId: message.id },
        createdAt: when,
      },
    });
  }
  // A person is handling this customer's chat right now (bot paused, an auto reply cancelled).
  const luis = customerIds[content.humanCustomer]!;
  await outbound(luis.conversationId, content.text.humanReply, at(0, 9), "human", "human");
  await outbound(
    luis.conversationId,
    content.text.botCanceledReply,
    at(0, 9),
    "bot",
    "auto_reply",
    "canceled",
  );
  await prisma.conversation.update({
    where: { id: luis.conversationId },
    data: {
      mode: "human",
      humanUntil: new Date(now.getTime() + 90 * 60_000),
      modeChangedAt: at(0, 9),
    },
  });
  await prisma.conversationModeChange.create({
    data: {
      conversationId: luis.conversationId,
      fromMode: "bot",
      toMode: "human",
      humanUntil: new Date(now.getTime() + 90 * 60_000),
      reason: "human_reply_panel",
      actorUserId: operator.id,
      createdAt: at(0, 9),
    },
  });
  // This customer asked to stop receiving automatic messages.
  const jorge = customerIds[content.optOutCustomer]!;
  const baja = await inbound(jorge.conversationId, content.text.optOut.keyword, at(3, 18));
  await outbound(
    jorge.conversationId,
    content.text.optOut.confirmation,
    at(3, 18),
    "bot",
    "compliance",
  );
  await prisma.contact.update({
    where: { id: jorge.contactId },
    data: { optOutAt: at(3, 18), optOutSource: "keyword" },
  });
  await prisma.contactConsentEvent.create({
    data: {
      contactId: jorge.contactId,
      kind: "opt_out",
      method: "keyword",
      keyword: content.text.optOut.consentKeyword,
      messageId: baja.id,
      createdAt: at(3, 18),
    },
  });

  // ── Chit-chat the pre-filter kept away from the LLM (savings on the dashboard) ─
  for (let daysAgo = 29; daysAgo >= 0; daysAgo -= 1) {
    const count = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i += 1) {
      const supplier = DEMO_SUPPLIERS[Math.floor(rand() * DEMO_SUPPLIERS.length)]!;
      const ids = await idsOf(supplier);
      const when = at(daysAgo, 8 + Math.floor(rand() * 10));
      const message = await inbound(
        ids.conversationId,
        content.chitchat[Math.floor(rand() * content.chitchat.length)]!,
        when,
      );
      await prisma.ingestionRun.create({
        data: {
          messageId: message.id,
          supplierId: ids.supplierId,
          classification: "other",
          status: "classified",
          prefilterRule: "no_price_signal",
          createdAt: when,
        },
      });
    }
  }

  // ── WhatsApp digests already sent to the team, with their panel link (phase 9 M7) ─
  // A fake team number (the demo sends nothing); /d/<link_token> opens them in the panel.
  const TEAM = content.teamWaId;
  const itemOf = (m: (typeof customerMessages)[number]): ItemData => ({
    category: m.kind === "order" ? "order" : "customer_query",
    messageId: m.messageId,
    contactName: DEMO_CUSTOMERS[m.who]!.name,
    preview: m.text.slice(0, 80),
  });
  const seededDigests: { items: ItemData[]; daysAgo: number }[] = [
    {
      daysAgo: 0,
      items: customerMessages
        .filter((m) => m.kind === "order")
        .slice(-2)
        .map(itemOf)
        .concat({
          category: "manual_attention",
          title: content.text.audioAlertTitle,
        }),
    },
    {
      daysAgo: 1,
      items: customerMessages
        .filter((m) => m.kind === "query")
        .slice(-1)
        .map(itemOf),
    },
  ];
  for (const [n, seeded] of seededDigests.entries()) {
    const sentAt = at(seeded.daysAgo, 11);
    const digest = await prisma.notificationDigest.create({
      data: {
        recipient: TEAM,
        status: "sent",
        windowEndsAt: sentAt,
        sentAt,
        channel: "text",
        text: renderDigest(seeded.items, { language: content.language }),
        // Deterministic (the WhatsApp link of a seeded digest survives resets); still login-only.
        linkToken: createHash("sha256").update(`smartops-demo:digest:${n}`).digest("base64url"),
        createdAt: sentAt,
      },
    });
    for (const [i, data] of seeded.items.entries()) {
      await prisma.notificationItem.create({
        data: {
          recipient: TEAM,
          category:
            data.category === "manual_attention"
              ? "manual_attention"
              : data.category === "order"
                ? "order"
                : "customer_query",
          dedupeKey: `demo-digest:${n}:${i}`,
          title:
            data.category === "manual_attention"
              ? data.title
              : content.text.itemTitle(
                  data.category === "order" ? "order" : "customer_query",
                  String("contactName" in data ? data.contactName : ""), // (as the template did)
                  "preview" in data ? data.preview : "",
                ),
          data: data as unknown as Prisma.InputJsonValue,
          digestId: digest.id,
          createdAt: new Date(sentAt.getTime() - 60_000 + i),
        },
      });
    }
  }

  // ── A few alerts of other kinds ─────────────────────────────────────────────
  await prisma.alert.createMany({
    data: [
      {
        type: "manual_attention",
        severity: "info",
        title: content.text.audioAlertTitle,
        createdAt: at(4),
      },
      {
        type: "integration_error",
        severity: "critical",
        status: "acknowledged",
        title: content.text.integrationAlertTitle,
        createdAt: at(11),
      },
    ],
  });

  const result: SeedResult = {
    suppliers: DEMO_SUPPLIERS.length,
    products: await prisma.product.count(),
    priceChanges,
    reviewItems,
    messages,
  };
  logger.info(result, "demo database seeded");
  return result;
}

async function seedColumnMappingReview(
  prisma: PrismaClient,
  content: DemoContent,
  ids: { contactId: string; conversationId: string; supplierId: string },
  when: Date,
): Promise<number> {
  const sheet = XLSX.utils.aoa_to_sheet(content.sheet.rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, content.sheet.name);
  const bytes = new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const filename = content.sheetFilename;
  const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const converted = await convertDocument({ bytes, mimeType, filename }, DEFAULT_CONVERSION_LIMITS);
  if (!converted.ok) throw new Error(`demo spreadsheet conversion failed: ${converted.reason}`);
  const table = converted.tables[0]!;

  const media = await prisma.mediaFile.create({
    data: {
      waMediaId: "demo-media-norte-sheet",
      mimeType,
      sizeBytes: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      filename,
      status: "stored",
      storage: "postgres",
      downloadedAt: when,
      createdAt: when,
      blob: { create: { data: bytes } },
      documentConversion: {
        create: {
          status: "done",
          format: converted.format,
          text: converted.text,
          charCount: converted.charCount,
          dataRows: converted.dataRows,
          truncated: converted.truncated,
          needsReview: converted.needsReview,
          sheets: converted.sheets as unknown as Prisma.InputJsonValue,
          tables: converted.tables as unknown as Prisma.InputJsonValue,
          warnings: converted.warnings as unknown as Prisma.InputJsonValue,
          converterVersion: CONVERTER_VERSION,
          completedAt: when,
          createdAt: when,
        },
      },
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      waMessageId: "wamid.DEMOSHEET0001",
      direction: "inbound",
      type: "document",
      author: "contact",
      text: content.sheetCaption,
      mediaFileId: media.id,
      waTimestamp: when,
      createdAt: when,
    },
  });
  await prisma.$executeRaw`
    UPDATE conversations
       SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${when}::timestamptz), ${when}::timestamptz),
           last_message_at = GREATEST(COALESCE(last_message_at, ${when}::timestamptz), ${when}::timestamptz)
     WHERE id = ${ids.conversationId}::uuid`;

  const answer = content.sheetMapper;
  const normalized = normalizeMapperTable(answer, table.rows[answer.headerRow]!.length);
  const proposal: ColumnMappingProposal = {
    reason: "new_format",
    supplierName: content.sheetProposal.supplierName,
    suspiciousInstructions: false,
    warnings: content.sheetProposal.warnings,
    retiredFormatIds: [],
    tables: [
      {
        table: answer.table,
        sheet: table.name,
        isPriceTable: true,
        headerRow: answer.headerRow,
        fingerprint: headerFingerprint(table.rows[answer.headerRow] ?? []),
        headerCells: table.rows[answer.headerRow]?.map(cellText) ?? [],
        mapping: normalized.mapping,
        ambiguous: normalized.ambiguous,
        recommendedPriceColumn: normalized.recommendedPriceColumn,
        confidence: answer.confidence,
        remembered: false,
        preview: sheetPreview(table, answer.headerRow, normalized.mapping),
        headerCandidates: headerCandidates(table),
      },
    ],
  };
  await prisma.ingestionRun.create({
    data: {
      messageId: message.id,
      supplierId: ids.supplierId,
      classification: "price_list_full",
      status: "needs_review",
      errors: { reason: "column_mapping_required" },
      model: "claude-sonnet-5",
      createdAt: when,
      finishedAt: new Date(when.getTime() + 7000),
      reviewItems: {
        create: {
          supplierId: ids.supplierId,
          scope: "run",
          kind: "column_mapping",
          dedupeKey: "gate:column_mapping:1",
          reasons: ["column_mapping_required"],
          proposal: proposal as unknown as Prisma.InputJsonValue,
          createdAt: when,
          updatedAt: when,
        },
      },
    },
  });
  return 1;
}
