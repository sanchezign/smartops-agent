import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type {
  AlertSeverity,
  NotificationCategory,
  NotificationDigestStatus,
} from "../../generated/prisma/enums.js";
import { lockKey } from "../catalog/catalog.repository.js";
import type { ItemData, RunFacts } from "./digest-rules.js";
import type { AckContext } from "./supplier-ack.js";

/** Notifications (phase 6). The only place in the notification flow that touches Prisma. */

export const PANEL = "panel";

export type ScheduleDigestInTx = (
  tx: Prisma.TransactionClient,
  digestId: string,
  startAfter: Date,
) => Promise<void>;

export interface RecordItemInput {
  recipients: string[];
  category: NotificationCategory;
  severity: AlertSeverity;
  dedupeKey: string;
  title: string;
  data: ItemData;
  windowMs: number;
  /** Critical items skip the window while the recipient is under this hourly cap. */
  criticalCap: number | null;
  now: Date;
}

export interface DigestRecord {
  id: string;
  recipient: string;
  status: NotificationDigestStatus;
  critical: boolean;
  windowEndsAt: Date;
  items: { data: ItemData }[];
}

export interface NotificationRepository {
  runFacts(runId: string, thresholdPct: number): Promise<RunFacts | null>;
  customerMessage(
    messageId: string,
  ): Promise<{ contactName: string | null; text: string | null } | null>;
  alertTitle(alertId: string): Promise<string | null>;
  /** Items per recipient (idempotent) + attach to digests; returns how many were new. */
  record(input: RecordItemInput): Promise<{ created: number; duplicates: number }>;
  getDigest(id: string): Promise<DigestRecord | null>;
  /** Send times of the recipient's digests of the last hour (critical or not). */
  recentSends(recipient: string, critical: boolean, now: Date): Promise<Date[]>;
  postpone(id: string, until: Date): Promise<void>;
  close(
    id: string,
    input: {
      status: "sent" | "panel_only" | "failed";
      text: string;
      channel: string;
      outboundMessageId: string | null;
      error?: string;
      sentAt: Date;
    },
  ): Promise<boolean>;
  createIntegrationAlert(input: { title: string; payload: Prisma.InputJsonValue }): Promise<string>;
  /** What the supplier acknowledgement needs about a run. */
  ackContext(runId: string): Promise<AckContext | null>;
}

export function createNotificationRepository(
  prisma: PrismaClient,
  deps: { scheduleDigestInTx: ScheduleDigestInTx },
): NotificationRepository {
  return {
    async runFacts(runId, thresholdPct) {
      const run = await prisma.ingestionRun.findUnique({
        where: { id: runId },
        select: { id: true, supplier: { select: { name: true } } },
      });
      if (!run) return null;
      const [increases, over, lowStock, pendingReviews] = await Promise.all([
        prisma.priceChange.count({ where: { ingestionRunId: runId, changePct: { gt: 0 } } }),
        prisma.priceChange.count({
          where: { ingestionRunId: runId, changePct: { gte: thresholdPct } },
        }),
        prisma.alert.count({ where: { ingestionRunId: runId, type: "low_stock" } }),
        prisma.reviewItem.count({ where: { ingestionRunId: runId, status: "pending" } }),
      ]);
      return {
        runId,
        supplierName: run.supplier?.name ?? null,
        increases,
        increasesOverThreshold: over,
        thresholdPct,
        lowStock,
        pendingReviews,
      };
    },

    async customerMessage(messageId) {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          text: true,
          transcript: true,
          conversation: { select: { contact: { select: { name: true } } } },
        },
      });
      if (!message) return null;
      return {
        contactName: message.conversation.contact.name,
        text: message.text ?? message.transcript,
      };
    },

    async alertTitle(alertId) {
      return (
        (await prisma.alert.findUnique({ where: { id: alertId }, select: { title: true } }))
          ?.title ?? null
      );
    },

    async record(input) {
      let created = 0;
      let duplicates = 0;
      for (const recipient of input.recipients) {
        await prisma.$transaction(async (tx) => {
          await lockKey(tx, `notifications:${recipient}`);
          const [item] = await tx.notificationItem.createManyAndReturn({
            data: [
              {
                recipient,
                category: input.category,
                severity: input.severity,
                dedupeKey: input.dedupeKey,
                title: input.title,
                data: input.data as unknown as Prisma.InputJsonValue,
              },
            ],
            skipDuplicates: true,
            select: { id: true },
          });
          if (!item) {
            duplicates += 1;
            return;
          }
          created += 1;
          if (recipient === PANEL) return;

          if (input.criticalCap !== null) {
            const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1000);
            const criticalSent = await tx.notificationDigest.count({
              where: { recipient, critical: true, windowEndsAt: { gt: hourAgo } },
            });
            if (criticalSent < input.criticalCap) {
              const digest = await tx.notificationDigest.create({
                data: { recipient, critical: true, windowEndsAt: input.now },
                select: { id: true },
              });
              await tx.notificationItem.update({
                where: { id: item.id },
                data: { digestId: digest.id },
              });
              await deps.scheduleDigestInTx(tx, digest.id, input.now);
              return;
            }
          }
          // Attach to the recipient's open digest whose window has not ended yet.
          const open = await tx.notificationDigest.findFirst({
            where: { recipient, status: "open", critical: false, windowEndsAt: { gt: input.now } },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });
          if (open) {
            await tx.notificationItem.update({
              where: { id: item.id },
              data: { digestId: open.id },
            });
            return;
          }
          const windowEndsAt = new Date(input.now.getTime() + input.windowMs);
          const digest = await tx.notificationDigest.create({
            data: { recipient, windowEndsAt },
            select: { id: true },
          });
          await tx.notificationItem.update({
            where: { id: item.id },
            data: { digestId: digest.id },
          });
          await deps.scheduleDigestInTx(tx, digest.id, windowEndsAt);
        });
      }
      return { created, duplicates };
    },

    async getDigest(id) {
      const digest = await prisma.notificationDigest.findUnique({
        where: { id },
        select: {
          id: true,
          recipient: true,
          status: true,
          critical: true,
          windowEndsAt: true,
          items: { select: { data: true }, orderBy: { createdAt: "asc" } },
        },
      });
      return digest
        ? { ...digest, items: digest.items.map((i) => ({ data: i.data as unknown as ItemData })) }
        : null;
    },

    async recentSends(recipient, critical, now) {
      const rows = await prisma.notificationDigest.findMany({
        where: {
          recipient,
          critical,
          status: "sent",
          sentAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
        },
        select: { sentAt: true },
      });
      return rows.map((r) => r.sentAt!).filter(Boolean);
    },

    async postpone(id, until) {
      await prisma.$transaction(async (tx) => {
        await tx.notificationDigest.update({ where: { id }, data: { windowEndsAt: until } });
        await deps.scheduleDigestInTx(tx, id, until);
      });
    },

    async close(id, input) {
      const done = await prisma.notificationDigest.updateMany({
        where: { id, status: "open" },
        data: {
          status: input.status,
          text: input.text,
          channel: input.channel,
          outboundMessageId: input.outboundMessageId,
          error: input.error ?? null,
          sentAt: input.sentAt,
        },
      });
      return done.count === 1;
    },

    async ackContext(runId) {
      const run = await prisma.ingestionRun.findUnique({
        where: { id: runId },
        select: {
          status: true,
          report: true,
          _count: { select: { reviewItems: { where: { status: "pending" } } } },
          message: {
            select: {
              conversation: {
                select: { id: true, mode: true, contact: { select: { kind: true } } },
              },
            },
          },
        },
      });
      if (!run) return null;
      const conversation = run.message.conversation;
      return {
        status: run.status,
        counts: (run.report as { counts?: AckContext["counts"] } | null)?.counts ?? null,
        pendingReviews: run._count.reviewItems,
        contactKind: conversation.contact.kind,
        conversationId: conversation.id,
        conversationMode: conversation.mode,
      };
    },

    async createIntegrationAlert(input) {
      const alert = await prisma.alert.create({
        data: {
          type: "integration_error",
          severity: "critical",
          title: input.title.slice(0, 300),
          payload: input.payload,
        },
        select: { id: true },
      });
      return alert.id;
    },
  };
}
