import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { CatalogIngestService, IngestResult } from "../catalog/catalog-ingest.service.js";
import { toPlain } from "../catalog/catalog.repository.js";
import { normalizeProductName } from "../catalog/normalize.js";
import { applyPercentage } from "../catalog/price-math.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { CatalogRepository } from "../catalog/catalog.repository.js";
import type { ColumnMappingProposal } from "../sheets/sheet-extraction.js";
import {
  choosePriceColumn,
  sheetMappingSchema,
  type SheetMapping,
} from "../sheets/sheet-mapping.js";
import type {
  ReviewItemRecord,
  ReviewListFilter,
  ReviewRepository,
  ReviewTx,
} from "./review.repository.js";
import {
  approveReviewSchema,
  rejectReviewSchema,
  type ApproveReviewInput,
  type GlobalChangeProposal,
  type LineProposal,
  type ReviewActor,
} from "./review.schemas.js";

const { Decimal } = Prisma;

/**
 * Human review (ADR-012): approve / reject review items.
 * - Every resolution is one transaction under the supplier lock (same lock as the ingest),
 *   moves the item out of `pending` atomically and writes an AuditLog row.
 * - A line/catalog proposal whose product changed since it was proposed (basePrice) is
 *   superseded and the call fails with 409 STALE_REVIEW.
 * - Run gates: tax_basis_changed / suspicious_instructions / unknown_supplier → approve
 *   re-runs the ingest with the human's decision; extraction_failed → the run goes back
 *   to be classified/extracted again (the AI call is made by n8n or the panel, never here).
 *   Rejecting a gate rejects the whole run.
 */

export interface ReviewResult {
  reviewItemId: string;
  kind: string;
  status: "approved" | "rejected";
  runId: string;
  resolution: Record<string, unknown>;
  /** Present when approving a run gate re-ran the ingest. */
  ingest?: IngestResult;
}

export interface ReviewService {
  list(filter: ReviewListFilter): Promise<ReviewItemRecord[]>;
  approve(id: string, input: unknown, actor: ReviewActor, log: Logger): Promise<ReviewResult>;
  reject(id: string, input: unknown, actor: ReviewActor, log: Logger): Promise<ReviewResult>;
}

const REINGEST_GATES = new Set([
  "tax_basis_changed",
  "suspicious_instructions",
  "unknown_supplier",
]);

type Outcome =
  | { stale: true; reason: string }
  | { stale: false; resolution: Record<string, unknown>; reingest: boolean };

export function createReviewService(deps: {
  repository: ReviewRepository;
  ingest: CatalogIngestService;
  settings: SettingsService;
  /** Supplier of a contact (link/create), for approving a spreadsheet format (M3c). */
  catalog: Pick<CatalogRepository, "resolveContactSupplier">;
  now?: () => Date;
}): ReviewService {
  const now = deps.now ?? (() => new Date());

  async function pendingItem(tx: ReviewTx, id: string): Promise<ReviewItemRecord> {
    const item = await tx.getItem(id);
    if (!item) throw errors.notFound("Review item not found");
    if (item.status !== "pending")
      throw errors.conflict(`Review item is already ${item.status}`, { status: item.status });
    return item;
  }

  async function approveLine(
    tx: ReviewTx,
    item: ReviewItemRecord,
    input: ApproveReviewInput,
    log: Logger,
  ): Promise<Outcome> {
    const proposal = item.proposal as LineProposal;
    const line = proposal.item;
    const supplierId = item.supplierId;
    if (!supplierId) throw errors.conflict("Review item has no supplier");
    const messageAt = new Date(proposal.messageAt);
    const base = {
      ingestionRunId: item.ingestionRunId,
      sourceMessageId: item.run.messageId,
      messageAt,
      source: "review" as const,
      reviewItemId: item.id,
      now: now(),
    };
    const targetId = input.createNew ? null : (input.productId ?? item.productId);

    if (targetId) {
      const product = await tx.getProduct(targetId);
      if (!product || product.supplierId !== supplierId)
        throw errors.badRequest("productId must be a product of the same supplier");
      if (
        targetId === item.productId &&
        item.basePrice &&
        (!product.price.eq(item.basePrice) || product.currency !== item.baseCurrency)
      ) {
        return { stale: true, reason: "product_changed_since_proposal" };
      }
      const newPrice = input.price
        ? new Decimal(input.price)
        : line.priceChangePct !== null
          ? applyPercentage(product.price, line.priceChangePct)
          : new Decimal(line.price!);
      const currency =
        input.currency ??
        (line.priceChangePct !== null && !input.price
          ? product.currency
          : (line.currency ?? proposal.listCurrency ?? product.currency));
      const settings = await deps.settings.getCatalogSettings(log);
      const written = await tx.writeProductPrice({
        ...base,
        productId: product.id,
        previous: { price: product.price, currency: product.currency },
        newPrice,
        newCurrency: currency,
        stock: line.stock,
        reactivate: !product.available && line.available !== false && settings.reactivateOnQuote,
      });
      if (written.changePct && written.changePct.abs().gte(settings.priceAlertPct)) {
        await tx.createPriceAlert({
          productId: product.id,
          ingestionRunId: item.ingestionRunId,
          title: `${product.name}: ${product.price.toFixed()} → ${newPrice.toFixed()} ${currency} (${written.changePct.toFixed()} %)`,
          payload: {
            oldPrice: product.price.toFixed(),
            newPrice: newPrice.toFixed(),
            currency,
            changePct: written.changePct.toFixed(),
          },
        });
      }
      return {
        stale: false,
        reingest: false,
        resolution: {
          productId: product.id,
          created: false,
          price: newPrice.toFixed(),
          currency,
          changed: written.changed,
          changePct: toPlain(written.changePct),
        },
      };
    }

    // New product.
    const name = input.name ?? line.name;
    const price = input.price ?? line.price;
    if (!price) throw errors.badRequest("price is required to create a product from a percentage");
    const currency = input.currency ?? line.currency ?? proposal.listCurrency;
    if (!currency) throw errors.badRequest("currency is required to create this product");
    if (await tx.productByNormalizedName(supplierId, normalizeProductName(name))) {
      throw errors.conflict("A product with that name already exists: approve with its productId");
    }
    const productId = await tx.createProduct({
      ...base,
      supplierId,
      name,
      sku: line.sku,
      unit: input.unit ?? line.unit,
      price: new Decimal(price),
      currency,
      stock: line.stock,
    });
    return {
      stale: false,
      reingest: false,
      resolution: { productId, created: true, price, currency, changed: true },
    };
  }

  async function approveCatalog(tx: ReviewTx, item: ReviewItemRecord): Promise<Outcome> {
    if (item.kind === "mark_unavailable") {
      if (item.productId) await tx.setProductAvailable(item.productId, false);
      return {
        stale: false,
        reingest: false,
        resolution: { productId: item.productId, available: false },
      };
    }
    // global_change: applied per product, only where the price is still the previewed one.
    const proposal = item.proposal as GlobalChangeProposal;
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const entry of proposal.products) {
      const product = await tx.getProduct(entry.productId);
      if (
        !product ||
        !product.price.eq(new Decimal(entry.oldPrice)) ||
        product.currency !== entry.currency
      ) {
        skipped.push(entry.productId);
        continue;
      }
      await tx.writeProductPrice({
        productId: product.id,
        previous: { price: product.price, currency: product.currency },
        newPrice: new Decimal(entry.newPrice),
        newCurrency: entry.currency,
        ingestionRunId: item.ingestionRunId,
        sourceMessageId: item.run.messageId,
        messageAt: new Date(proposal.messageAt),
        source: "review",
        reviewItemId: item.id,
        now: now(),
      });
      applied.push(product.id);
    }
    return { stale: false, reingest: false, resolution: { pct: proposal.pct, applied, skipped } };
  }

  /**
   * column_mapping (M3c): every table that is not remembered yet is saved as an ACTIVE
   * format of the supplier (one per header fingerprint). A table with several price columns
   * needs the reviewer's priceColumn (taxIncluded follows the chosen column). The run goes
   * back to "classified": the next extract reads the whole file deterministically.
   */
  async function approveColumnMapping(
    tx: ReviewTx,
    item: ReviewItemRecord,
    input: ApproveReviewInput,
    supplierId: string,
    actor: ReviewActor,
  ): Promise<Outcome> {
    const proposal = item.proposal as ColumnMappingProposal;
    const saved: Record<string, unknown>[] = [];
    for (const table of proposal.tables) {
      if (table.remembered) continue;
      const choice = input.tables?.find((t) => t.table === table.table);
      const isPriceTable = choice?.isPriceTable ?? table.isPriceTable;
      const headerRow = choice?.headerRow ?? table.headerRow;
      const header = table.headerCandidates.find((c) => c.row === headerRow);
      if (!header) {
        if (!isPriceTable) continue; // notes without a header: nothing to remember
        throw errors.badRequest(`${table.table}: row R${headerRow} is not a header row`);
      }
      let mapping: SheetMapping | null = null;
      if (isPriceTable) {
        const base = {
          ...table.mapping,
          ...(choice?.nameColumn !== undefined ? { nameColumn: choice.nameColumn } : {}),
          ...(choice?.unitColumn !== undefined ? { unitColumn: choice.unitColumn } : {}),
          ...(choice?.skuColumn !== undefined ? { skuColumn: choice.skuColumn } : {}),
          ...(choice?.priceFormat ? { priceFormat: choice.priceFormat } : {}),
          ...(choice?.currency !== undefined ? { currency: choice.currency } : {}),
        };
        const priceColumn = choice?.priceColumn ?? base.priceColumn;
        if (priceColumn === null && base.pctColumn === null) {
          throw errors.badRequest(
            `${table.table} has several price columns (${base.priceColumns
              .map((p) => `C${p.column} "${p.header}"`)
              .join(", ")}): choose priceColumn`,
            { table: table.table, priceColumns: base.priceColumns },
          );
        }
        const parsed = sheetMappingSchema.safeParse(
          priceColumn === null ? base : choosePriceColumn(base, priceColumn),
        );
        if (!parsed.success) throw errors.validation(parsed.error.issues);
        mapping = parsed.data;
      }
      const formatId = await tx.saveSheetFormat({
        supplierId,
        fingerprint: header.fingerprint,
        headerCells: header.cells,
        sheetName: table.sheet,
        format: mapping ? { isPriceTable: true, mapping } : { isPriceTable: false, mapping: null },
        approvedById: actor.type === "user" ? (actor.userId ?? null) : null,
        reviewItemId: item.id,
      });
      saved.push({
        table: table.table,
        formatId,
        isPriceTable,
        priceColumn: mapping?.priceColumn ?? null,
        taxIncluded: mapping?.taxIncluded ?? null,
      });
    }
    if (!(await tx.moveRun(item.ingestionRunId, "needs_review", "classified")))
      throw errors.conflict(`Run is ${item.run.status}, expected needs_review`);
    return {
      stale: false,
      reingest: false,
      resolution: { supplierId, formats: saved, next: "extract" },
    };
  }

  async function approveGate(
    tx: ReviewTx,
    item: ReviewItemRecord,
    input: ApproveReviewInput,
  ): Promise<Outcome> {
    if (item.kind === "extraction_failed") {
      const task = (item.proposal as { task?: string }).task;
      const to = task === "classify" ? "pending" : "classified";
      if (!(await tx.moveRun(item.ingestionRunId, "needs_review", to)))
        throw errors.conflict(`Run is ${item.run.status}, expected needs_review`);
      return {
        stale: false,
        reingest: false,
        resolution: { retry: task ?? "extract", runStatus: to },
      };
    }
    const resolution: Record<string, unknown> = {};
    if (item.kind === "unknown_supplier") {
      await tx.lockContact(item.run.contactId);
      let supplierId = input.supplierId;
      if (supplierId) {
        if (!(await tx.supplierExists(supplierId))) throw errors.badRequest("supplierId not found");
      } else if (input.createSupplier) {
        supplierId = (await tx.createSupplier(input.createSupplier)).id;
        resolution.supplierCreated = true;
      } else {
        throw errors.badRequest("supplierId or createSupplier is required");
      }
      await tx.linkContactToSupplier(item.run.contactId, supplierId);
      resolution.supplierId = supplierId;
    }
    if (!(await tx.moveRun(item.ingestionRunId, "needs_review", "extracted")))
      throw errors.conflict(`Run is ${item.run.status}, expected needs_review`);
    return { stale: false, reingest: true, resolution };
  }

  return {
    list: (filter) => deps.repository.list(filter),

    async approve(id, rawInput, actor, log) {
      const parsed = approveReviewSchema.safeParse(rawInput ?? {});
      if (!parsed.success) throw errors.validation(parsed.error.issues);
      const input = parsed.data;
      const preview = await deps.repository.getItem(id);
      if (!preview) throw errors.notFound("Review item not found");

      // column_mapping: the format belongs to a supplier → resolve it first (M4 rule).
      let mappingSupplierId: string | null = null;
      if (preview.kind === "column_mapping" && preview.status === "pending") {
        if (input.supplierId) {
          mappingSupplierId = input.supplierId;
        } else {
          const resolution = await deps.catalog.resolveContactSupplier(
            preview.run.contactId,
            (preview.proposal as ColumnMappingProposal).supplierName,
          );
          if (resolution.status === "ambiguous") {
            throw errors.conflict("Several suppliers match: approve with supplierId", {
              candidates: resolution.candidates,
            });
          }
          mappingSupplierId = resolution.supplierId;
        }
      }

      const outcome = await deps.repository.transaction(async (tx) => {
        const lockId = mappingSupplierId ?? preview.supplierId;
        if (lockId) await tx.lockSupplier(lockId);
        const item = await pendingItem(tx, id);
        if (item.kind === "column_mapping" && input.supplierId) {
          if (!(await tx.supplierExists(input.supplierId)))
            throw errors.badRequest("supplierId not found");
          await tx.lockContact(item.run.contactId);
          await tx.linkContactToSupplier(item.run.contactId, input.supplierId);
        }
        const result =
          item.kind === "column_mapping"
            ? await approveColumnMapping(tx, item, input, mappingSupplierId!, actor)
            : item.scope === "line"
              ? await approveLine(tx, item, input, log)
              : item.scope === "catalog"
                ? await approveCatalog(tx, item)
                : await approveGate(tx, item, input);
        if (result.stale) {
          await tx.resolve(id, "superseded", { reason: result.reason }, actor);
          await tx.audit({
            actor,
            action: "review.superseded",
            entityId: id,
            data: { reason: result.reason },
          });
          return { item, result };
        }
        const resolution = { ...result.resolution, ...(input.note ? { note: input.note } : {}) };
        await tx.resolve(id, "approved", resolution as Prisma.InputJsonValue, actor);
        await tx.audit({
          actor,
          action: "review.approve",
          entityId: id,
          data: {
            kind: item.kind,
            runId: item.ingestionRunId,
            resolution,
          } as Prisma.InputJsonValue,
        });
        return { item, result: { ...result, resolution } };
      });

      if (outcome.result.stale) {
        throw errors.staleReview(
          "The product changed since this was proposed; the item was superseded",
          {
            reason: outcome.result.reason,
          },
        );
      }
      const response: ReviewResult = {
        reviewItemId: id,
        kind: outcome.item.kind,
        status: "approved",
        runId: outcome.item.ingestionRunId,
        resolution: outcome.result.resolution,
      };
      log.info({ reviewItemId: id, kind: outcome.item.kind, actor: actor.type }, "review approved");
      if (outcome.result.reingest && REINGEST_GATES.has(outcome.item.kind)) {
        response.ingest = await deps.ingest.ingest(outcome.item.ingestionRunId, log);
      }
      return response;
    },

    async reject(id, rawInput, actor, log) {
      const parsed = rejectReviewSchema.safeParse(rawInput ?? {});
      if (!parsed.success) throw errors.validation(parsed.error.issues);
      const preview = await deps.repository.getItem(id);
      if (!preview) throw errors.notFound("Review item not found");

      const item = await deps.repository.transaction(async (tx) => {
        if (preview.supplierId) await tx.lockSupplier(preview.supplierId);
        const current = await pendingItem(tx, id);
        const resolution = parsed.data.note ? { note: parsed.data.note } : {};
        if (current.scope === "run") {
          await tx.moveRun(current.ingestionRunId, "needs_review", "rejected");
        }
        await tx.resolve(id, "rejected", resolution, actor);
        await tx.audit({
          actor,
          action: "review.reject",
          entityId: id,
          data: { kind: current.kind, runId: current.ingestionRunId, ...resolution },
        });
        return current;
      });
      log.info({ reviewItemId: id, kind: item.kind, actor: actor.type }, "review rejected");
      return {
        reviewItemId: id,
        kind: item.kind,
        status: "rejected",
        runId: item.ingestionRunId,
        resolution: parsed.data.note ? { note: parsed.data.note } : {},
      };
    },
  };
}
