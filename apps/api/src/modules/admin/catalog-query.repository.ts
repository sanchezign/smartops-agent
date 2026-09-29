import { alertDetails } from "./alert-details.js";
import type { PrismaClient } from "../../common/db.js";
import { errors } from "../../common/errors/app-error.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AlertStatus, AlertType } from "../../generated/prisma/enums.js";
import { normalizeSupplierName } from "../catalog/supplier-name.js";

/**
 * Catalog, price history and alerts for the panel (phase 9 M5). Reads, plus two small audited
 * writes: rename a supplier (admin) and acknowledge an alert. Prices and percentages stay
 * Prisma Decimals (serialized as strings, never floats).
 */

export interface ProductFilter {
  supplierId?: string;
  q?: string;
  availability?: "all" | "available" | "unavailable";
  cursor?: string;
  limit: number;
}

export type AlertFilter = { status: "open" | "all"; type?: AlertType; limit: number };

const OPEN_ALERT_STATUSES: AlertStatus[] = ["open", "sent"];

export function createCatalogQueryRepository(prisma: PrismaClient) {
  return {
    /** Suppliers with their product counts and when they last sent something. */
    async suppliers() {
      const suppliers = await prisma.supplier.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          taxIncluded: true,
          _count: { select: { products: true } },
        },
      });
      const [available, lastRun] = await Promise.all([
        prisma.product.groupBy({
          by: ["supplierId"],
          where: { available: true },
          _count: { _all: true },
        }),
        prisma.ingestionRun.groupBy({
          by: ["supplierId"],
          where: { supplierId: { not: null }, status: "ingested" },
          _max: { createdAt: true },
        }),
      ]);
      const availableBy = new Map(available.map((a) => [a.supplierId, a._count._all]));
      const lastBy = new Map(lastRun.map((r) => [r.supplierId, r._max.createdAt]));
      return suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        taxIncluded: s.taxIncluded,
        products: s._count.products,
        available: availableBy.get(s.id) ?? 0,
        lastListAt: lastBy.get(s.id) ?? null,
      }));
    },

    async products(filter: ProductFilter) {
      const where: Prisma.ProductWhereInput = {
        ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
        ...(filter.q ? { name: { contains: filter.q, mode: "insensitive" } } : {}),
        ...(filter.availability === "available"
          ? { available: true }
          : filter.availability === "unavailable"
            ? { available: false }
            : {}),
      };
      const rows = await prisma.product.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: filter.limit + 1,
        ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          price: true,
          currency: true,
          available: true,
          stock: true,
          priceSourceAt: true,
          supplier: { select: { id: true, name: true } },
          priceChanges: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { changePct: true, currencyChanged: true, createdAt: true },
          },
        },
      });
      const page = rows.slice(0, filter.limit);
      return {
        items: page.map(({ priceChanges, ...p }) => ({
          ...p,
          lastChange: priceChanges[0] ?? null,
        })),
        nextCursor: rows.length > filter.limit ? page[page.length - 1]!.id : null,
      };
    },

    /** A product with its whole price history (oldest first, capped at 500 changes). */
    async product(id: string) {
      const product = await prisma.product.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          price: true,
          currency: true,
          available: true,
          stock: true,
          priceSourceAt: true,
          createdAt: true,
          supplier: { select: { id: true, name: true, taxIncluded: true } },
        },
      });
      if (!product) return null;
      const history = await prisma.priceChange.findMany({
        where: { productId: id },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          oldPrice: true,
          oldCurrency: true,
          newPrice: true,
          newCurrency: true,
          changePct: true,
          currencyChanged: true,
          source: true,
          createdAt: true,
          sourceMessage: { select: { id: true, conversationId: true } },
        },
      });
      return {
        ...product,
        history: history.reverse().map(({ sourceMessage, ...h }) => ({
          ...h,
          conversationId: sourceMessage?.conversationId ?? null,
        })),
      };
    },

    /**
     * Rename a supplier (admin, audited). The normalized name follows, so later lists that
     * state the new name match it (supplier resolution, ADR-012). Merging suppliers is a later
     * feature: a name that another supplier already has is refused.
     */
    async renameSupplier(input: {
      supplierId: string;
      name: string;
      actor: { userId: string; requestId?: string | null };
    }) {
      const normalizedName = normalizeSupplierName(input.name);
      if (!normalizedName) throw errors.badRequest("The name has no letters or digits");
      return prisma.$transaction(async (tx) => {
        const current = await tx.supplier.findUnique({
          where: { id: input.supplierId },
          select: { id: true, name: true },
        });
        if (!current) throw errors.notFound("Supplier not found");
        const clash = await tx.supplier.findFirst({
          where: { normalizedName, id: { not: input.supplierId } },
          select: { id: true, name: true },
        });
        if (clash) {
          throw errors.conflict("Another supplier already has that name (merging comes later)", {
            supplierId: clash.id,
            name: clash.name,
          });
        }
        if (current.name === input.name)
          return { id: current.id, name: current.name, changed: false };
        const updated = await tx.supplier.update({
          where: { id: input.supplierId },
          data: { name: input.name, normalizedName },
          select: { id: true, name: true },
        });
        await tx.auditLog.create({
          data: {
            actorType: "user",
            userId: input.actor.userId,
            action: "supplier.renamed",
            entity: "supplier",
            entityId: current.id,
            data: { from: current.name, to: input.name },
            requestId: input.actor.requestId ?? null,
          },
        });
        return { ...updated, changed: true };
      });
    },

    async alerts(filter: AlertFilter) {
      const where: Prisma.AlertWhereInput = {
        ...(filter.status === "open" ? { status: { in: OPEN_ALERT_STATUSES } } : {}),
        ...(filter.type ? { type: filter.type } : {}),
      };
      const [items, open] = await Promise.all([
        prisma.alert.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: filter.limit,
          select: {
            id: true,
            type: true,
            severity: true,
            status: true,
            title: true,
            payload: true,
            createdAt: true,
            product: { select: { id: true, name: true } },
            ingestionRun: {
              select: { id: true, message: { select: { conversationId: true } } },
            },
          },
        }),
        prisma.alert.count({ where: { status: { in: OPEN_ALERT_STATUSES } } }),
      ]);
      return {
        open,
        items: items.map(({ ingestionRun, payload, ...a }) => ({
          ...a,
          // Phase 13: the panel writes the alert in its language from these fields.
          details: alertDetails(a.type, payload),
          conversationId: ingestionRun?.message.conversationId ?? null,
        })),
      };
    },

    /** open / sent → acknowledged (idempotent), audited. */
    async acknowledgeAlert(input: {
      alertId: string;
      actor: { userId: string; requestId?: string | null };
    }) {
      return prisma.$transaction(async (tx) => {
        const alert = await tx.alert.findUnique({
          where: { id: input.alertId },
          select: { id: true, status: true },
        });
        if (!alert) throw errors.notFound("Alert not found");
        const updated = await tx.alert.updateMany({
          where: { id: input.alertId, status: { in: OPEN_ALERT_STATUSES } },
          data: { status: "acknowledged" },
        });
        if (updated.count === 1) {
          await tx.auditLog.create({
            data: {
              actorType: "user",
              userId: input.actor.userId,
              action: "alert.acknowledged",
              entity: "alert",
              entityId: alert.id,
              data: { from: alert.status },
              requestId: input.actor.requestId ?? null,
            },
          });
        }
        return { changed: updated.count === 1 };
      });
    },
  };
}
export type CatalogQueryRepository = ReturnType<typeof createCatalogQueryRepository>;
