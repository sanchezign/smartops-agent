import type { PrismaClient } from "../../common/db.js";
import type { ApplyModeEventResult } from "../conversations/conversation-mode.repository.js";
import type { OnHumanMessageInTx } from "../conversations/conversation-mode.service.js";
import type { OnComplianceMessageInTx } from "../optout/optout.service.js";
import type { EmitMessageReadyInTx } from "../integration/message-ready.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { WebhookEventStatus } from "../../generated/prisma/enums.js";
import { planContactUpsert, type ContactPlanResult } from "./contact-identity.js";
import { allowedPreviousStatuses, toMessageStatus } from "./message-status.js";
import type {
  ParsedEcho,
  ParsedInboundMessage,
  ParsedStatus,
  ParsedUserPreference,
} from "./whatsapp-webhook.parser.js";

/**
 * Persistence for the webhook worker. The ONLY place in this flow that touches Prisma.
 * Idempotency is enforced by the database: unique Message.waMessageId and unique
 * MessageStatusEvent (waMessageId, status).
 */

export interface StoredWebhookEvent {
  id: string;
  status: WebhookEventStatus;
  payload: unknown;
}

export type IngestMessageResult =
  | {
      outcome: "created";
      messageId: string;
      contactId: string;
      conversationId: string;
      conflict?: ContactPlanResult["conflict"];
    }
  | { outcome: "duplicate" };

/** Coexistence echo (phase 7 M2). */
export type IngestEchoResult =
  | {
      outcome: "created";
      messageId: string;
      contactId: string;
      conversationId: string;
      /** Human takeover applied in the same transaction (null if no hook). */
      takeover: ApplyModeEventResult | null;
    }
  | { outcome: "duplicate" }
  | { outcome: "applied"; kind: "revoke" | "edit"; messageId: string }
  | { outcome: "original_not_found"; kind: "revoke" | "edit" };

export interface RecordStatusResult {
  /** The (waMessageId, status) pair was already recorded. */
  duplicate: boolean;
  /** Our Message row, if this wamid was sent through the API. */
  messageId: string | null;
  /** The Message status moved forward. */
  messageUpdated: boolean;
}

/** What to do with the media of an inbound message (decided by the ingest service). */
export interface MediaIngestPlan {
  status: "pending" | "skipped" | "rejected";
  rejectReason?: string;
}

/**
 * Enqueues the media download job INSIDE the ingestion transaction (pg-boss
 * `fromPrisma(tx)`): the message and its job are committed — or rolled back — together.
 */
export type EnqueueMediaInTx = (tx: Prisma.TransactionClient, mediaFileId: string) => Promise<void>;

export interface WhatsAppIngestRepository {
  getEvent(id: string): Promise<StoredWebhookEvent | null>;
  incrementAttempts(id: string): Promise<void>;
  /** received → processed | ignored (no-op if the event is no longer `received`). */
  finishEvent(id: string, status: "processed" | "ignored", note?: string): Promise<void>;
  recordEventError(id: string, error: string): Promise<void>;
  /** received → failed (retries exhausted). */
  markEventFailed(id: string, error: string): Promise<void>;
  ingestInboundMessage(input: {
    message: ParsedInboundMessage;
    webhookEventId: string;
    /** Required when the message has media. */
    mediaPlan?: MediaIngestPlan;
  }): Promise<IngestMessageResult>;
  recordStatus(input: {
    status: ParsedStatus;
    webhookEventId: string;
  }): Promise<RecordStatusResult>;
  /**
   * A message a person sent from the WhatsApp Business app: stored as an OUTBOUND human
   * message (idempotent by wamid, media metadata only) + human takeover in the same
   * transaction. revoke / edit update the original message.
   */
  ingestEcho(input: { echo: ParsedEcho; webhookEventId: string }): Promise<IngestEchoResult>;
  /**
   * user_preferences webhook (phase 7): informational marketing opt-out/in, recorded on
   * the contact. We send no marketing messages — nothing else reacts to this.
   */
  recordUserPreference(preference: ParsedUserPreference): Promise<void>;
}

const MAX_ERROR_LENGTH = 2_000;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH)}…` : value;
}

export function createWhatsAppIngestRepository(
  prisma: PrismaClient,
  deps: {
    enqueueMediaInTx: EnqueueMediaInTx;
    /** Outbox "message.ready" (phase 6): here for messages without pending media. */
    emitMessageReadyInTx?: EmitMessageReadyInTx;
    /** Human takeover when a person writes from the WhatsApp Business app (phase 7). */
    onHumanMessageInTx?: OnHumanMessageInTx;
    /** Opt-out / opt-in keyword detection (phase 7, ADR-017). */
    onComplianceMessageInTx?: OnComplianceMessageInTx;
  },
): WhatsAppIngestRepository {
  async function ingestEchoOnce(
    echo: ParsedEcho,
    webhookEventId: string,
  ): Promise<IngestEchoResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.message.findUnique({
        where: { waMessageId: echo.waMessageId },
        select: { id: true },
      });
      if (existing) return { outcome: "duplicate" as const };

      const where = echo.toWaId ? { waId: echo.toWaId } : { bsuid: echo.toUserId as string };
      // The person may write first to a new contact: create it (no opt-in: WE wrote).
      const contact =
        (await tx.contact.findUnique({ where, select: { id: true } })) ??
        (await tx.contact.create({ data: where, select: { id: true } }));
      const conversation = await tx.conversation.upsert({
        where: { contactId: contact.id },
        create: { contactId: contact.id },
        update: {},
        select: { id: true },
      });
      const at = echo.timestamp ?? new Date();
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          waMessageId: echo.waMessageId,
          direction: "outbound",
          type: echo.type,
          author: "human",
          purpose: "human",
          text: echo.text,
          status: "sent",
          statusAt: at,
          waTimestamp: echo.timestamp,
          webhookEventId,
          raw: {
            source: "whatsapp_business_app",
            echo: echo.raw,
            // Metadata only — echo media is never downloaded.
            ...(echo.media ? { media: echo.media } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.$executeRaw`
        UPDATE conversations
           SET last_message_at = GREATEST(COALESCE(last_message_at, ${at}::timestamptz), ${at}::timestamptz),
               updated_at = now()
         WHERE id = ${conversation.id}::uuid`;
      const takeover = deps.onHumanMessageInTx
        ? await deps.onHumanMessageInTx(tx, {
            conversationId: conversation.id,
            messageId: message.id,
            messageAt: echo.timestamp,
            source: "app",
          })
        : null;
      return {
        outcome: "created" as const,
        messageId: message.id,
        contactId: contact.id,
        conversationId: conversation.id,
        takeover,
      };
    });
  }

  async function applyEchoChange(echo: ParsedEcho): Promise<IngestEchoResult> {
    const kind = echo.kind as "revoke" | "edit";
    if (!echo.originalWaMessageId) return { outcome: "original_not_found", kind };
    return prisma.$transaction(async (tx) => {
      const original = await tx.message.findUnique({
        where: { waMessageId: echo.originalWaMessageId as string },
        select: { id: true, text: true, raw: true, revokedAt: true },
      });
      if (!original) return { outcome: "original_not_found" as const, kind };
      const at = echo.timestamp ?? new Date();
      if (kind === "revoke") {
        if (!original.revokedAt)
          await tx.message.update({ where: { id: original.id }, data: { revokedAt: at } });
        return { outcome: "applied" as const, kind, messageId: original.id };
      }
      const raw = (original.raw ?? {}) as { edits?: { wamid: string }[] } & Record<string, unknown>;
      const edits = raw.edits ?? [];
      if (!edits.some((e) => e.wamid === echo.waMessageId)) {
        await tx.message.update({
          where: { id: original.id },
          data: {
            text: echo.text,
            editedAt: at,
            raw: {
              ...raw,
              edits: [
                ...edits,
                { wamid: echo.waMessageId, at: at.toISOString(), previousText: original.text },
              ],
            } as Prisma.InputJsonValue,
          },
        });
      }
      return { outcome: "applied" as const, kind, messageId: original.id };
    });
  }

  async function ingestOnce(
    message: ParsedInboundMessage,
    webhookEventId: string,
    mediaPlan: MediaIngestPlan | undefined,
  ): Promise<IngestMessageResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.message.findUnique({
        where: { waMessageId: message.waMessageId },
        select: { id: true },
      });
      if (existing) return { outcome: "duplicate" as const };

      const contactSelect = { id: true, waId: true, bsuid: true, name: true, username: true };
      const [byBsuid, byWaId] = await Promise.all([
        message.fromUserId
          ? tx.contact.findUnique({ where: { bsuid: message.fromUserId }, select: contactSelect })
          : null,
        message.fromWaId
          ? tx.contact.findUnique({ where: { waId: message.fromWaId }, select: contactSelect })
          : null,
      ]);
      const { plan, conflict } = planContactUpsert(byBsuid, byWaId, {
        waId: message.fromWaId,
        bsuid: message.fromUserId,
        name: message.contactName,
        username: message.username,
      });

      let contactId: string;
      if (plan.action === "create") {
        contactId = (await tx.contact.create({ data: plan.data, select: { id: true } })).id;
      } else if (plan.action === "update") {
        await tx.contact.update({ where: { id: plan.id }, data: plan.data });
        contactId = plan.id;
      } else {
        contactId = plan.id;
      }

      // ADR-009: a contact who writes to us first has an implicit opt-in.
      await tx.contact.updateMany({
        where: { id: contactId, optInAt: null },
        data: { optInAt: message.timestamp ?? new Date(), optInSource: "inbound" },
      });

      const conversation = await tx.conversation.upsert({
        where: { contactId },
        create: { contactId },
        update: {},
        select: { id: true },
      });

      // Monotonic timestamps: an older, late-delivered message never moves them back.
      const at = message.timestamp ?? new Date();
      await tx.$executeRaw`
        UPDATE conversations
           SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${at}::timestamptz), ${at}::timestamptz),
               last_message_at = GREATEST(COALESCE(last_message_at, ${at}::timestamptz), ${at}::timestamptz),
               updated_at = now()
         WHERE id = ${conversation.id}::uuid`;

      const media = mediaPlan ?? { status: "pending" as const };
      const mediaFile = message.media
        ? await tx.mediaFile.create({
            data: {
              waMediaId: message.media.waMediaId,
              mimeType: message.media.mimeType ?? "application/octet-stream",
              sha256: message.media.sha256,
              filename: message.media.filename,
              status: media.status,
              rejectReason: media.rejectReason ?? null,
            },
            select: { id: true },
          })
        : null;
      if (mediaFile && media.status === "pending") {
        await deps.enqueueMediaInTx(tx, mediaFile.id);
      }

      const firstError = message.errors[0];
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          waMessageId: message.waMessageId,
          direction: "inbound",
          type: message.type,
          author: "contact",
          text: message.text,
          status: "received",
          waTimestamp: message.timestamp,
          raw: message.raw as Prisma.InputJsonValue,
          webhookEventId,
          mediaFileId: mediaFile?.id ?? null,
          ...(firstError
            ? {
                errorCode: String(firstError.code),
                errorMessage: firstError.title ?? firstError.message ?? null,
              }
            : {}),
        },
        select: { id: true },
      });
      if (deps.onComplianceMessageInTx) {
        await deps.onComplianceMessageInTx(tx, {
          contactId,
          messageId: created.id,
          text: message.text,
          at,
        });
      }
      if (deps.emitMessageReadyInTx && (!mediaFile || media.status !== "pending")) {
        await deps.emitMessageReadyInTx(tx, { messageId: created.id });
      }

      return {
        outcome: "created" as const,
        messageId: created.id,
        contactId,
        conversationId: conversation.id,
        ...(conflict ? { conflict } : {}),
      };
    });
  }

  return {
    async getEvent(id) {
      return prisma.webhookEvent.findUnique({
        where: { id },
        select: { id: true, status: true, payload: true },
      });
    },

    async incrementAttempts(id) {
      await prisma.webhookEvent.update({ where: { id }, data: { attempts: { increment: 1 } } });
    },

    async finishEvent(id, status, note) {
      await prisma.webhookEvent.updateMany({
        where: { id, status: "received" },
        data: { status, processedAt: new Date(), error: note ?? null },
      });
    },

    async recordEventError(id, error) {
      await prisma.webhookEvent.update({ where: { id }, data: { error: truncate(error) } });
    },

    async markEventFailed(id, error) {
      await prisma.webhookEvent.updateMany({
        where: { id, status: "received" },
        data: { status: "failed", error: truncate(error) },
      });
    },

    async ingestInboundMessage({ message, webhookEventId, mediaPlan }) {
      try {
        return await ingestOnce(message, webhookEventId, mediaPlan);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost a race: either the same message (duplicate delivery processed in
        // parallel) or the same new contact/conversation. Re-check, then retry once.
        const existing = await prisma.message.findUnique({
          where: { waMessageId: message.waMessageId },
          select: { id: true },
        });
        if (existing) return { outcome: "duplicate" };
        return ingestOnce(message, webhookEventId, mediaPlan);
      }
    },

    async ingestEcho({ echo, webhookEventId }) {
      if (echo.kind !== "message") return applyEchoChange(echo);
      try {
        return await ingestEchoOnce(echo, webhookEventId);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await prisma.message.findUnique({
          where: { waMessageId: echo.waMessageId },
          select: { id: true },
        });
        if (existing) return { outcome: "duplicate" };
        return ingestEchoOnce(echo, webhookEventId);
      }
    },

    async recordUserPreference(preference) {
      if (preference.category !== "marketing_messages") return;
      if (preference.value !== "stop" && preference.value !== "resume") return;
      await prisma.contact.updateMany({
        where: { waId: preference.waId },
        data: {
          marketingOptOutAt:
            preference.value === "stop" ? (preference.timestamp ?? new Date()) : null,
        },
      });
    },

    async recordStatus({ status, webhookEventId }) {
      const message = await prisma.message.findUnique({
        where: { waMessageId: status.waMessageId },
        select: { id: true },
      });

      const inserted = await prisma.messageStatusEvent.createMany({
        data: [
          {
            waMessageId: status.waMessageId,
            status: status.status,
            occurredAt: status.timestamp,
            recipientWaId: status.recipientWaId,
            recipientUserId: status.recipientUserId,
            errors: status.errors.length > 0 ? (status.errors as Prisma.InputJsonValue) : undefined,
            pricing: status.pricing ? (status.pricing as Prisma.InputJsonValue) : undefined,
            messageId: message?.id ?? null,
            webhookEventId,
          },
        ],
        skipDuplicates: true,
      });

      let messageUpdated = false;
      const next = toMessageStatus(status.status);
      if (message && next) {
        const firstError = status.errors[0];
        // Conditional update = atomic forward-only transition (safe under concurrency).
        const updated = await prisma.message.updateMany({
          where: {
            id: message.id,
            direction: "outbound",
            status: { in: allowedPreviousStatuses(next) },
          },
          data: {
            status: next,
            statusAt: status.timestamp ?? new Date(),
            ...(next === "failed" && firstError
              ? {
                  errorCode: String(firstError.code),
                  errorMessage: firstError.title ?? firstError.message ?? null,
                }
              : {}),
          },
        });
        messageUpdated = updated.count > 0;
      }

      return { duplicate: inserted.count === 0, messageId: message?.id ?? null, messageUpdated };
    },
  };
}
