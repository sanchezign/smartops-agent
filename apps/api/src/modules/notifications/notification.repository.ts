import { randomBytes } from "node:crypto";
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
  /** Deep link token (null for digests created before phase 9 M7). */
  linkToken: string | null;
  items: { data: ItemData }[];
}

/** 256 random bits, URL-safe (43 chars): the digest deep link /d/<token> (phase 9 M7). */
export const newLinkToken = () => randomBytes(32).toString("base64url");

export interface NotificationRepository {
  runFacts(runId: string, thresholdPct: number): Promise<RunFacts | null>;
  customerMessage(
    messageId: string,
  ): Promise<{ contactName: string | null; text: string | null } | null>;
  /** The alert behind a manual_attention item: fallback title + the structured fields. */
  alertSummary(alertId: string): Promise<{
    title: string;
    reason?: string;
    durationSeconds: number | null;
    sizeBytes: number | null;
    maxSeconds: number | null;
  } | null>;
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
      // The biggest change of the run (by absolute %), shown in the WhatsApp digest line.
      const [up, down] = await Promise.all(
        (["desc", "asc"] as const).map((order) =>
          prisma.priceChange.findFirst({
            where: { ingestionRunId: runId, changePct: { not: null } },
            orderBy: { changePct: order },
            select: {
              oldPrice: true,
              newPrice: true,
              newCurrency: true,
              changePct: true,
              product: { select: { name: true } },
            },
          }),
        ),
      );
      const biggest = [up, down]
        .filter((c): c is NonNullable<typeof c> => Boolean(c?.oldPrice && c.changePct))
        .sort((a, b) => b.changePct!.abs().comparedTo(a.changePct!.abs()))[0];
      return {
        runId,
        supplierName: run.supplier?.name ?? null,
        mainChange: biggest
          ? {
              productName: biggest.product.name,
              oldPrice: biggest.oldPrice!.toFixed(),
              newPrice: biggest.newPrice.toFixed(),
              currency: biggest.newCurrency,
              changePct: biggest.changePct!.toFixed(),
            }
          : null,
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

    async alertSummary(alertId) {
      const alert = await prisma.alert.findUnique({
        where: { id: alertId },
        select: { title: true, payload: true },
      });
      if (!alert) return null;
      const payload = (alert.payload ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      return {
        title: alert.title,
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        durationSeconds: num(payload.durationSeconds),
        sizeBytes: num(payload.sizeBytes),
        maxSeconds: num(payload.maxSeconds),
      };
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
                data: {
                  recipient,
                  critical: true,
                  windowEndsAt: input.now,
                  linkToken: newLinkToken(),
                },
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
            data: { recipient, windowEndsAt, linkToken: newLinkToken() },
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
          linkToken: true,
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
              createdAt: true,
              conversation: {
                select: {
                  id: true,
                  mode: true,
                  humanUntil: true,
                  modeChangedAt: true,
                  contact: { select: { kind: true } },
                },
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
        humanUntil: conversation.humanUntil,
        modeChangedAt: conversation.modeChangedAt,
        messageReceivedAt: run.message.createdAt,
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
