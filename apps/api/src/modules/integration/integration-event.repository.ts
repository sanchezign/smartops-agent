import type { PrismaClient } from "../../common/db.js";
import type { IntegrationEventStatus } from "../../generated/prisma/enums.js";

/** Outbox towards n8n. The only place in the delivery flow that touches Prisma. */

export interface EventForDelivery {
  id: string;
  type: string;
  status: IntegrationEventStatus;
  payload: unknown;
  attempts: number;
}

export interface IntegrationEventRepository {
  getForDelivery(id: string): Promise<EventForDelivery | null>;
  /** pending → delivered (no-op otherwise). */
  markDelivered(id: string): Promise<boolean>;
  recordFailure(id: string, error: string): Promise<void>;
  /** pending → failed + integration_error alert, in one transaction. */
  markFailed(id: string, error: string): Promise<boolean>;
  /** Pending events not touched for a while: their job was lost (e.g. crash). */
  findStalePending(before: Date, limit: number): Promise<string[]>;
  /**
   * Delivered events whose message still has no ingestion run: n8n accepted them but never
   * processed them. Bounded by maxRedeliveries.
   */
  findDeliveredWithoutRun(before: Date, maxRedeliveries: number, limit: number): Promise<string[]>;
  /** Back to pending (touching updatedAt) for a new delivery; counts a redelivery if asked. */
  requeue(ids: string[], options: { redelivery: boolean; resetAttempts: boolean }): Promise<void>;
  findFailed(options: { since?: Date; limit: number }): Promise<string[]>;
}

const truncate = (value: string) => (value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value);

export function createIntegrationEventRepository(prisma: PrismaClient): IntegrationEventRepository {
  return {
    getForDelivery: (id) =>
      prisma.integrationEvent.findUnique({
        where: { id },
        select: { id: true, type: true, status: true, payload: true, attempts: true },
      }),

    async markDelivered(id) {
      const done = await prisma.integrationEvent.updateMany({
        where: { id, status: "pending" },
        data: { status: "delivered", deliveredAt: new Date(), lastError: null },
      });
      return done.count === 1;
    },

    async recordFailure(id, error) {
      await prisma.integrationEvent.updateMany({
        where: { id },
        data: { attempts: { increment: 1 }, lastError: truncate(error) },
      });
    },

    async markFailed(id, error) {
      return prisma.$transaction(async (tx) => {
        const done = await tx.integrationEvent.updateMany({
          where: { id, status: "pending" },
          data: { status: "failed", failedAt: new Date(), lastError: truncate(error) },
        });
        if (done.count !== 1) return false;
        const event = await tx.integrationEvent.findUniqueOrThrow({
          where: { id },
          select: { messageId: true, attempts: true, type: true },
        });
        await tx.alert.create({
          data: {
            type: "integration_error",
            severity: "critical",
            title:
              "n8n no recibió un mensaje después de ~24 h de reintentos: revisar n8n y reenviar (n8n:replay)",
            payload: {
              reason: "n8n_delivery_failed",
              eventId: id,
              eventType: event.type,
              messageId: event.messageId,
              attempts: event.attempts,
            },
          },
        });
        return true;
      });
    },

    async findStalePending(before, limit) {
      const rows = await prisma.integrationEvent.findMany({
        where: { status: "pending", updatedAt: { lt: before } },
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async findDeliveredWithoutRun(before, maxRedeliveries, limit) {
      const rows = await prisma.integrationEvent.findMany({
        where: {
          status: "delivered",
          deliveredAt: { lt: before },
          redeliveries: { lt: maxRedeliveries },
          message: { ingestionRuns: { none: {} } },
        },
        orderBy: { deliveredAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async requeue(ids, options) {
      if (ids.length === 0) return;
      await prisma.integrationEvent.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "pending",
          failedAt: null,
          ...(options.redelivery ? { redeliveries: { increment: 1 } } : {}),
          ...(options.resetAttempts ? { attempts: 0 } : {}),
        },
      });
    },

    async findFailed({ since, limit }) {
      const rows = await prisma.integrationEvent.findMany({
        where: { status: "failed", ...(since ? { failedAt: { gte: since } } : {}) },
        orderBy: { failedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
  };
}
