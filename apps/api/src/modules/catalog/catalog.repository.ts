import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type {
  ContactKind,
  IngestionClassification,
  IngestionStatus,
  ReviewKind,
  ReviewScope,
} from "../../generated/prisma/enums.js";
import type {
  CatalogProductState,
  CatalogReview,
  GlobalChangePlan,
  PlannedLine,
} from "./ingest-plan.js";
import { normalizeProductName } from "./normalize.js";
import { computePriceChange } from "./price-change.js";
import { normalizeSupplierName } from "./supplier-name.js";

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;

/**
 * Catalog persistence (phase 5 M4). The only place that writes products, price changes,
 * suppliers and review items for the ingest; review.repository.ts reuses the exported
 * write helpers so approvals follow exactly the same rules.
 * Every catalog write runs under a per-supplier advisory lock (lockKey) so two lists of
 * the same supplier — or a list and an approval — never interleave.
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/** Transaction-scoped advisory lock (released on commit/rollback). */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export const supplierLockKey = (supplierId: string) => `catalog:supplier:${supplierId}`;
export const contactLockKey = (contactId: string) => `catalog:contact:${contactId}`;

export function toPlain(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

// ─── Shared write helpers (ingest + review approvals) ────────────────────────

export interface PriceWrite {
  productId: string;
  previous: { price: Decimal; currency: string };
  newPrice: Decimal;
  newCurrency: string;
  ingestionRunId: string;
  sourceMessageId: string;
  messageAt: Date;
  source: "auto" | "review";
  reviewItemId?: string;
  stock?: number | null;
  reactivate?: boolean;
  now: Date;
}

/** Updates a product's price (or only lastSeenAt/stock when unchanged) + PriceChange. */
export async function writeProductPrice(
  tx: Tx,
  input: PriceWrite,
): Promise<{ changed: boolean; changePct: Decimal | null }> {
  const changed =
    !input.previous.price.eq(input.newPrice) || input.previous.currency !== input.newCurrency;
  const data: Prisma.ProductUpdateInput = { lastSeenAt: input.now };
  if (input.stock !== undefined && input.stock !== null) data.stock = input.stock;
  if (input.reactivate) data.available = true;
  let changePct: Decimal | null = null;
  if (changed) {
    data.price = input.newPrice;
    data.currency = input.newCurrency;
    data.priceSourceAt = input.messageAt;
    const values = computePriceChange(input.previous, {
      price: input.newPrice,
      currency: input.newCurrency,
    });
    changePct = values.changePct;
    await tx.priceChange.create({
      data: {
        productId: input.productId,
        ...values,
        source: input.source,
        reviewItemId: input.reviewItemId ?? null,
        ingestionRunId: input.ingestionRunId,
        sourceMessageId: input.sourceMessageId,
      },
    });
  }
  await tx.product.update({ where: { id: input.productId }, data });
  return { changed, changePct };
}

export interface ProductCreate {
  supplierId: string;
  name: string;
  sku: string | null;
  unit: string | null;
  price: Decimal;
  currency: string;
  stock: number | null;
  ingestionRunId: string;
  sourceMessageId: string;
  messageAt: Date;
  source: "auto" | "review";
  reviewItemId?: string;
  now: Date;
}

/** Creates a product with its first PriceChange (oldPrice null). */
export async function createProductWithPrice(tx: Tx, input: ProductCreate): Promise<string> {
  const product = await tx.product.create({
    data: {
      supplierId: input.supplierId,
      name: input.name,
      normalizedName: normalizeProductName(input.name),
      sku: input.sku,
      unit: input.unit,
      price: input.price,
      currency: input.currency,
      stock: input.stock,
      available: true,
      lastSeenAt: input.now,
      priceSourceAt: input.messageAt,
    },
    select: { id: true },
  });
  await tx.priceChange.create({
    data: {
      productId: product.id,
      ...computePriceChange(null, { price: input.price, currency: input.currency }),
      source: input.source,
      reviewItemId: input.reviewItemId ?? null,
      ingestionRunId: input.ingestionRunId,
      sourceMessageId: input.sourceMessageId,
    },
  });
  return product.id;
}

export async function loadCatalog(tx: Tx, supplierId: string): Promise<CatalogProductState[]> {
  const rows = await tx.product.findMany({
    where: { supplierId },
    select: {
      id: true,
      name: true,
      normalizedName: true,
      unit: true,
      price: true,
      currency: true,
      available: true,
      stock: true,
      priceSourceAt: true,
    },
  });
  return rows;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestContext {
  run: {
    id: string;
    messageId: string;
    status: IngestionStatus;
    classification: IngestionClassification | null;
    supplierId: string | null;
    rawExtraction: unknown;
    report: unknown;
  };
  messageAt: Date;
  contact: {
    id: string;
    name: string | null;
    waId: string | null;
    bsuid: string | null;
    kind: ContactKind;
    supplierId: string | null;
  };
  approvedGates: ReviewKind[];
  pendingGates: { id: string; kind: ReviewKind }[];
}

export interface GateInput {
  runId: string;
  supplierId: string | null;
  kind: ReviewKind;
  reasons: string[];
  proposal: Prisma.InputJsonValue;
}

export interface ApplyPlanInput {
  runId: string;
  messageId: string;
  messageAt: Date;
  supplierId: string;
  lines: PlannedLine[];
  catalogReviews: CatalogReview[];
  globalChange: GlobalChangePlan | null;
  taxIncluded: boolean | null;
  listCurrency: string | null;
  catalog: CatalogProductState[];
  now: Date;
}

export interface AppliedLine {
  index: number;
  productId: string | null;
  changePct: string | null;
}

export interface ApplyPlanResult {
  lines: AppliedLine[];
  reviewItems: number;
  alerts: number;
  superseded: number;
}

export interface CatalogTx {
  lock(key: string): Promise<void>;
  /** Fresh read under the contact lock (another run may have linked it meanwhile). */
  contactSupplierId(contactId: string): Promise<string | null>;
  suppliersByNormalizedName(normalized: string): Promise<{ id: string; name: string }[]>;
  getSupplier(id: string): Promise<{
    id: string;
    name: string;
    normalizedName: string;
    taxIncluded: boolean | null;
  } | null>;
  createSupplier(name: string): Promise<{ id: string; name: string }>;
  linkContact(contactId: string, supplierId: string, kind: ContactKind): Promise<void>;
  loadCatalog(supplierId: string): Promise<CatalogProductState[]>;
  createGate(input: GateInput): Promise<void>;
  applyPlan(input: ApplyPlanInput): Promise<ApplyPlanResult>;
  finishRun(
    runId: string,
    data: {
      status: "ingested" | "needs_review";
      supplierId: string | null;
      report: Prisma.InputJsonValue;
    },
  ): Promise<void>;
}

export interface CatalogRepository {
  getIngestContext(runId: string): Promise<IngestContext | null>;
  /** Atomic extracted → ingesting. */
  claimForIngest(runId: string): Promise<boolean>;
  /** ingesting → extracted (after an unexpected failure, so it can be retried). */
  releaseIngest(runId: string): Promise<void>;
  transaction<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T>;
}

const LINE_SCOPE: ReviewScope = "line";

function lineProposal(
  line: PlannedLine,
  input: ApplyPlanInput,
  byId: Map<string, CatalogProductState>,
): Prisma.InputJsonValue {
  return {
    lineIndex: line.index,
    item: line.item as unknown as Prisma.InputJsonValue,
    listCurrency: input.listCurrency,
    messageAt: input.messageAt.toISOString(),
    candidates: line.candidateIds.map((id) => {
      const p = byId.get(id);
      return {
        id,
        name: p?.name ?? null,
        unit: p?.unit ?? null,
        price: toPlain(p?.price),
        currency: p?.currency ?? null,
      };
    }),
    proposedPrice: toPlain(line.newPrice),
    currency: line.currency,
    changePct: toPlain(line.changePct),
  };
}

function createCatalogTx(tx: Tx): CatalogTx {
  return {
    lock: (key) => lockKey(tx, key),

    async contactSupplierId(contactId) {
      const contact = await tx.contact.findUnique({
        where: { id: contactId },
        select: { supplierId: true },
      });
      return contact?.supplierId ?? null;
    },

    suppliersByNormalizedName: (normalized) =>
      tx.supplier.findMany({
        where: { normalizedName: normalized },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      }),

    getSupplier: (id) =>
      tx.supplier.findUnique({
        where: { id },
        select: { id: true, name: true, normalizedName: true, taxIncluded: true },
      }),

    createSupplier: (name) =>
      tx.supplier.create({
        data: { name, normalizedName: normalizeSupplierName(name) },
        select: { id: true, name: true },
      }),

    async linkContact(contactId, supplierId, kind) {
      await tx.contact.update({
        where: { id: contactId },
        data: { supplierId, ...(kind === "unknown" ? { kind: "supplier" } : {}) },
      });
    },

    loadCatalog: (supplierId) => loadCatalog(tx, supplierId),

    async createGate(input) {
      await tx.reviewItem.createMany({
        data: [
          {
            ingestionRunId: input.runId,
            supplierId: input.supplierId,
            scope: "run",
            kind: input.kind,
            dedupeKey: `gate:${input.kind}`,
            reasons: input.reasons,
            proposal: input.proposal,
          },
        ],
        skipDuplicates: true,
      });
    },

    async applyPlan(input) {
      const byId = new Map(input.catalog.map((p) => [p.id, p]));
      const applied: AppliedLine[] = [];
      const reviewRows: Prisma.ReviewItemCreateManyInput[] = [];
      const alertRows: Prisma.AlertCreateManyInput[] = [];
      const touched = new Set<string>();
      const base = {
        ingestionRunId: input.runId,
        sourceMessageId: input.messageId,
        messageAt: input.messageAt,
        source: "auto" as const,
        now: input.now,
      };

      for (const line of input.lines) {
        let productId = line.productId;
        let changePct: Decimal | null = null;
        if (line.action === "create") {
          productId = await createProductWithPrice(tx, {
            ...base,
            supplierId: input.supplierId,
            name: line.item.name,
            sku: line.item.sku,
            unit: line.item.unit,
            price: line.newPrice!,
            currency: line.currency!,
            stock: line.stock,
          });
        } else if (line.action === "update" || line.action === "unchanged") {
          const previous = byId.get(line.productId!)!;
          ({ changePct } = await writeProductPrice(tx, {
            ...base,
            productId: previous.id,
            previous: { price: previous.price, currency: previous.currency },
            newPrice: line.newPrice!,
            newCurrency: line.currency!,
            stock: line.stock,
            reactivate: line.reactivate,
          }));
        } else {
          const candidate = line.productId ? byId.get(line.productId) : undefined;
          reviewRows.push({
            ingestionRunId: input.runId,
            supplierId: input.supplierId,
            productId: line.productId,
            scope: LINE_SCOPE,
            kind: line.kind!,
            dedupeKey: `line:${line.index}`,
            reasons: line.reasons,
            proposal: lineProposal(line, input, byId),
            basePrice: candidate?.price ?? null,
            baseCurrency: candidate?.currency ?? null,
          });
        }
        for (const id of line.candidateIds) touched.add(id);
        if (productId) touched.add(productId);
        applied.push({ index: line.index, productId, changePct: toPlain(changePct) });

        if (line.priceAlert && productId) {
          alertRows.push({
            type: "price_change",
            severity: "warning",
            title: `${line.item.name}: ${toPlain(line.oldPrice)} → ${toPlain(line.newPrice)} ${line.currency} (${toPlain(line.changePct)} %)`,
            productId,
            ingestionRunId: input.runId,
            payload: {
              oldPrice: toPlain(line.oldPrice),
              newPrice: toPlain(line.newPrice),
              currency: line.currency,
              changePct: toPlain(line.changePct),
            },
          });
        }
        if (line.lowStock && productId) {
          alertRows.push({
            type: "low_stock",
            severity: "warning",
            title: `${line.item.name}: stock ${line.stock}`,
            productId,
            ingestionRunId: input.runId,
            payload: { stock: line.stock },
          });
        }
      }

      for (const review of input.catalogReviews) {
        const p = byId.get(review.productId);
        reviewRows.push({
          ingestionRunId: input.runId,
          supplierId: input.supplierId,
          productId: review.productId,
          scope: "catalog",
          kind: "mark_unavailable",
          dedupeKey: `unavailable:${review.productId}`,
          reasons: [review.reason],
          proposal: {
            reason: review.reason,
            lineIndex: review.lineIndex,
            productName: p?.name ?? null,
          },
        });
      }
      if (input.globalChange) {
        reviewRows.push({
          ingestionRunId: input.runId,
          supplierId: input.supplierId,
          scope: "catalog",
          kind: "global_change",
          dedupeKey: "global",
          reasons: ["global_change"],
          proposal: {
            pct: input.globalChange.pct,
            messageAt: input.messageAt.toISOString(),
            products: input.globalChange.products.map((g) => ({
              productId: g.productId,
              name: g.name,
              oldPrice: g.oldPrice.toFixed(),
              newPrice: g.newPrice.toFixed(),
              currency: g.currency,
              changePct: toPlain(g.changePct),
              outlier: g.outlier,
            })),
          },
        });
      }

      // Newer information supersedes pending proposals of older runs.
      const superseded = await tx.reviewItem.updateMany({
        where: {
          status: "pending",
          ingestionRunId: { not: input.runId },
          OR: [
            { productId: { in: [...touched] }, scope: { in: ["line", "catalog"] } },
            ...(input.globalChange
              ? [{ supplierId: input.supplierId, kind: "global_change" as const }]
              : []),
          ],
        },
        data: { status: "superseded", resolvedAt: input.now },
      });

      if (reviewRows.length > 0)
        await tx.reviewItem.createMany({ data: reviewRows, skipDuplicates: true });
      if (alertRows.length > 0) await tx.alert.createMany({ data: alertRows });
      if (input.taxIncluded !== null) {
        await tx.supplier.update({
          where: { id: input.supplierId },
          data: { taxIncluded: input.taxIncluded, taxIncludedAt: input.now },
        });
      }
      return {
        lines: applied,
        reviewItems: reviewRows.length,
        alerts: alertRows.length,
        superseded: superseded.count,
      };
    },

    async finishRun(runId, data) {
      await tx.ingestionRun.update({
        where: { id: runId },
        data: {
          status: data.status,
          supplierId: data.supplierId,
          report: data.report,
          finishedAt: new Date(),
        },
      });
    },
  };
}

export function createCatalogRepository(prisma: PrismaClient): CatalogRepository {
  return {
    async getIngestContext(runId) {
      const run = await prisma.ingestionRun.findUnique({
        where: { id: runId },
        select: {
          id: true,
          messageId: true,
          status: true,
          classification: true,
          supplierId: true,
          rawExtraction: true,
          report: true,
          message: {
            select: {
              waTimestamp: true,
              createdAt: true,
              conversation: {
                select: {
                  contact: {
                    select: {
                      id: true,
                      name: true,
                      waId: true,
                      bsuid: true,
                      kind: true,
                      supplierId: true,
                    },
                  },
                },
              },
            },
          },
          reviewItems: {
            where: { scope: "run", status: { in: ["pending", "approved"] } },
            select: { id: true, kind: true, status: true },
          },
        },
      });
      if (!run) return null;
      const { message, reviewItems, ...rest } = run;
      return {
        run: rest,
        messageAt: message.waTimestamp ?? message.createdAt,
        contact: message.conversation.contact,
        approvedGates: reviewItems.filter((r) => r.status === "approved").map((r) => r.kind),
        pendingGates: reviewItems
          .filter((r) => r.status === "pending")
          .map((r) => ({ id: r.id, kind: r.kind })),
      };
    },

    async claimForIngest(runId) {
      const claimed = await prisma.ingestionRun.updateMany({
        where: { id: runId, status: "extracted" },
        data: { status: "ingesting" },
      });
      return claimed.count === 1;
    },

    async releaseIngest(runId) {
      await prisma.ingestionRun.updateMany({
        where: { id: runId, status: "ingesting" },
        data: { status: "extracted" },
      });
    },

    transaction: (fn) => prisma.$transaction((tx) => fn(createCatalogTx(tx)), TX_OPTIONS),
  };
}
