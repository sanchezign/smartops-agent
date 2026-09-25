import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type {
  IngestionStatus,
  ReviewKind,
  ReviewScope,
  ReviewStatus,
} from "../../generated/prisma/enums.js";
import {
  contactLockKey,
  createProductWithPrice,
  lockKey,
  supplierLockKey,
  writeProductPrice,
  type PriceWrite,
  type ProductCreate,
} from "../catalog/catalog.repository.js";
import { normalizeSupplierName } from "../catalog/supplier-name.js";
import type { ReviewActor } from "./review.schemas.js";

type Tx = Prisma.TransactionClient;

/** Review items (ADR-012): reads for the queue and the writes of approve/reject. */

export interface ReviewItemRecord {
  id: string;
  ingestionRunId: string;
  supplierId: string | null;
  productId: string | null;
  scope: ReviewScope;
  kind: ReviewKind;
  status: ReviewStatus;
  reasons: string[];
  proposal: unknown;
  basePrice: Prisma.Decimal | null;
  baseCurrency: string | null;
  resolution: unknown;
  resolvedAt: Date | null;
  createdAt: Date;
  run: { status: IngestionStatus; messageId: string; contactId: string };
}

export interface ProductRecord {
  id: string;
  supplierId: string;
  name: string;
  normalizedName: string;
  price: Prisma.Decimal;
  currency: string;
  available: boolean;
}

export interface ReviewListFilter {
  status?: ReviewStatus;
  supplierId?: string;
  kind?: ReviewKind;
  ingestionRunId?: string;
  limit?: number;
}

export interface ReviewTx {
  lockSupplier(supplierId: string): Promise<void>;
  lockContact(contactId: string): Promise<void>;
  getItem(id: string): Promise<ReviewItemRecord | null>;
  getProduct(id: string): Promise<ProductRecord | null>;
  productByNormalizedName(
    supplierId: string,
    normalizedName: string,
  ): Promise<{ id: string } | null>;
  writeProductPrice(
    input: PriceWrite,
  ): Promise<{ changed: boolean; changePct: Prisma.Decimal | null }>;
  createProduct(input: ProductCreate): Promise<string>;
  setProductAvailable(productId: string, available: boolean): Promise<void>;
  createPriceAlert(input: {
    productId: string;
    ingestionRunId: string;
    title: string;
    payload: Prisma.InputJsonValue;
  }): Promise<void>;
  supplierExists(id: string): Promise<boolean>;
  createSupplier(name: string): Promise<{ id: string; name: string }>;
  linkContactToSupplier(contactId: string, supplierId: string): Promise<void>;
  /** Conditional run transition (from → to). */
  moveRun(runId: string, from: IngestionStatus, to: IngestionStatus): Promise<boolean>;
  resolve(
    id: string,
    status: "approved" | "rejected" | "superseded",
    resolution: Prisma.InputJsonValue,
    actor: ReviewActor,
  ): Promise<boolean>;
  audit(input: {
    actor: ReviewActor;
    action: string;
    entityId: string;
    data: Prisma.InputJsonValue;
  }): Promise<void>;
}

export interface ReviewRepository {
  getItem(id: string): Promise<ReviewItemRecord | null>;
  list(filter: ReviewListFilter): Promise<ReviewItemRecord[]>;
  transaction<T>(fn: (tx: ReviewTx) => Promise<T>): Promise<T>;
}

const itemSelect = {
  id: true,
  ingestionRunId: true,
  supplierId: true,
  productId: true,
  scope: true,
  kind: true,
  status: true,
  reasons: true,
  proposal: true,
  basePrice: true,
  baseCurrency: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  ingestionRun: {
    select: {
      status: true,
      messageId: true,
      message: { select: { conversation: { select: { contactId: true } } } },
    },
  },
} as const;

type ItemRow = Prisma.ReviewItemGetPayload<{ select: typeof itemSelect }>;

function toRecord(row: ItemRow): ReviewItemRecord {
  const { ingestionRun, ...rest } = row;
  return {
    ...rest,
    run: {
      status: ingestionRun.status,
      messageId: ingestionRun.messageId,
      contactId: ingestionRun.message.conversation.contactId,
    },
  };
}

function createReviewTx(tx: Tx): ReviewTx {
  return {
    lockSupplier: (supplierId) => lockKey(tx, supplierLockKey(supplierId)),
    lockContact: (contactId) => lockKey(tx, contactLockKey(contactId)),

    async getItem(id) {
      const row = await tx.reviewItem.findUnique({ where: { id }, select: itemSelect });
      return row ? toRecord(row) : null;
    },

    getProduct: (id) =>
      tx.product.findUnique({
        where: { id },
        select: {
          id: true,
          supplierId: true,
          name: true,
          normalizedName: true,
          price: true,
          currency: true,
          available: true,
        },
      }),

    productByNormalizedName: (supplierId, normalizedName) =>
      tx.product.findUnique({
        where: { supplierId_normalizedName: { supplierId, normalizedName } },
        select: { id: true },
      }),

    writeProductPrice: (input) => writeProductPrice(tx, input),
    createProduct: (input) => createProductWithPrice(tx, input),

    async setProductAvailable(productId, available) {
      await tx.product.update({ where: { id: productId }, data: { available } });
    },

    async createPriceAlert(input) {
      await tx.alert.create({
        data: {
          type: "price_change",
          severity: "warning",
          title: input.title,
          productId: input.productId,
          ingestionRunId: input.ingestionRunId,
          payload: input.payload,
        },
      });
    },

    async supplierExists(id) {
      return (await tx.supplier.count({ where: { id } })) === 1;
    },

    createSupplier: (name) =>
      tx.supplier.create({
        data: { name, normalizedName: normalizeSupplierName(name) },
        select: { id: true, name: true },
      }),

    async linkContactToSupplier(contactId, supplierId) {
      const contact = await tx.contact.findUniqueOrThrow({
        where: { id: contactId },
        select: { kind: true },
      });
      await tx.contact.update({
        where: { id: contactId },
        data: { supplierId, ...(contact.kind === "unknown" ? { kind: "supplier" } : {}) },
      });
    },

    async moveRun(runId, from, to) {
      const moved = await tx.ingestionRun.updateMany({
        where: { id: runId, status: from },
        data: {
          status: to,
          ...(to === "rejected" ? { finishedAt: new Date() } : { finishedAt: null }),
        },
      });
      return moved.count === 1;
    },

    async resolve(id, status, resolution, actor) {
      const done = await tx.reviewItem.updateMany({
        where: { id, status: "pending" },
        data: {
          status,
          resolution,
          resolvedAt: new Date(),
          resolvedById: actor.type === "user" ? (actor.userId ?? null) : null,
        },
      });
      return done.count === 1;
    },

    async audit(input) {
      await tx.auditLog.create({
        data: {
          actorType: input.actor.type,
          userId: input.actor.type === "user" ? (input.actor.userId ?? null) : null,
          action: input.action,
          entity: "review_item",
          entityId: input.entityId,
          data: input.data,
          requestId: input.actor.requestId ?? null,
        },
      });
    },
  };
}

export function createReviewRepository(prisma: PrismaClient): ReviewRepository {
  return {
    async getItem(id) {
      const row = await prisma.reviewItem.findUnique({ where: { id }, select: itemSelect });
      return row ? toRecord(row) : null;
    },

    async list(filter) {
      const rows = await prisma.reviewItem.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.ingestionRunId ? { ingestionRunId: filter.ingestionRunId } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: Math.min(filter.limit ?? 100, 500),
        select: itemSelect,
      });
      return rows.map(toRecord);
    },

    transaction: (fn) =>
      prisma.$transaction((tx) => fn(createReviewTx(tx)), { timeout: 20_000, maxWait: 10_000 }),
  };
}
