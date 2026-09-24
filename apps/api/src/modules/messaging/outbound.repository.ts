import type { PrismaClient } from "../../common/db.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { MessageAuthor, MessageStatus, OptInSource } from "../../generated/prisma/enums.js";
import { allowedPreviousStatuses, toMessageStatus } from "../whatsapp/message-status.js";

/** Outbound messages + opt-in. The only place in the outbound flow that touches Prisma. */

export type RecipientRef = { conversationId: string } | { waId: string } | { bsuid: string };

export interface RecipientContact {
  contact: {
    id: string;
    waId: string | null;
    bsuid: string | null;
    optInAt: Date | null;
    optInSource: OptInSource | null;
  };
  conversation: { id: string; lastInboundAt: Date | null } | null;
}

export interface OutboundForSend {
  id: string;
  status: MessageStatus;
  waMessageId: string | null;
  type: string;
  conversationId: string;
  lastInboundAt: Date | null;
  contactOptInAt: Date | null;
  /** Stored Graph request payload. */
  request: Record<string, unknown>;
}

/**
 * Enqueues the send job INSIDE the transaction that creates the message, keyed by
 * conversation (pg-boss key_strict_fifo → strict order per conversation).
 */
export type EnqueueOutboundInTx = (
  tx: Prisma.TransactionClient,
  input: { messageId: string; conversationId: string },
) => Promise<void>;

export interface OutboundRepository {
  findByIdempotencyKey(key: string): Promise<{ id: string; status: MessageStatus } | null>;
  findRecipient(ref: RecipientRef): Promise<RecipientContact | null>;
  /** Creates the contact if missing; keeps an existing opt-in untouched. */
  recordOptIn(
    ref: { waId: string } | { bsuid: string },
    source: OptInSource,
    at: Date,
  ): Promise<{ contactId: string; optInAt: Date; optInSource: OptInSource; created: boolean }>;
  createOutbound(input: {
    contactId: string;
    type: "text" | "template";
    text: string | null;
    author: MessageAuthor;
    authorUserId?: string;
    idempotencyKey?: string;
    request: Record<string, unknown>;
  }): Promise<{ messageId: string; conversationId: string; duplicate: boolean }>;
  getForSend(messageId: string): Promise<OutboundForSend | null>;
  /** pending → accepted by Meta: stores the wamid, then applies statuses that arrived first. */
  markAccepted(
    messageId: string,
    input: { wamid: string; response: Record<string, unknown>; at: Date },
  ): Promise<{ appliedStatuses: number }>;
  /** pending → failed (no-op otherwise). */
  markFailed(messageId: string, errorCode: string, errorMessage: string): Promise<void>;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const STATUS_ORDER = ["sent", "delivered", "read", "played", "failed"];

export function createOutboundRepository(
  prisma: PrismaClient,
  deps: { enqueueOutboundInTx: EnqueueOutboundInTx },
): OutboundRepository {
  const contactSelect = {
    id: true,
    waId: true,
    bsuid: true,
    optInAt: true,
    optInSource: true,
    conversation: { select: { id: true, lastInboundAt: true } },
  } as const;

  return {
    async findByIdempotencyKey(key) {
      return prisma.message.findUnique({
        where: { idempotencyKey: key },
        select: { id: true, status: true },
      });
    },

    async findRecipient(ref) {
      const contact =
        "conversationId" in ref
          ? (
              await prisma.conversation.findUnique({
                where: { id: ref.conversationId },
                select: { contact: { select: contactSelect } },
              })
            )?.contact
          : await prisma.contact.findUnique({
              where: "waId" in ref ? { waId: ref.waId } : { bsuid: ref.bsuid },
              select: contactSelect,
            });
      if (!contact) return null;
      const { conversation, ...rest } = contact;
      return { contact: rest, conversation: conversation ?? null };
    },

    async recordOptIn(ref, source, at) {
      const where = "waId" in ref ? { waId: ref.waId } : { bsuid: ref.bsuid };
      const existing = await prisma.contact.findUnique({ where, select: { id: true } });
      if (!existing) {
        try {
          const created = await prisma.contact.create({
            data: { ...where, optInAt: at, optInSource: source },
            select: { id: true, optInAt: true, optInSource: true },
          });
          return {
            contactId: created.id,
            optInAt: created.optInAt ?? at,
            optInSource: created.optInSource ?? source,
            created: true,
          };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      await prisma.contact.updateMany({
        where: { ...where, optInAt: null },
        data: { optInAt: at, optInSource: source },
      });
      const contact = await prisma.contact.findUniqueOrThrow({
        where,
        select: { id: true, optInAt: true, optInSource: true },
      });
      return {
        contactId: contact.id,
        optInAt: contact.optInAt ?? at,
        optInSource: contact.optInSource ?? source,
        created: false,
      };
    },

    async createOutbound(input) {
      try {
        return await prisma.$transaction(async (tx) => {
          const conversation = await tx.conversation.upsert({
            where: { contactId: input.contactId },
            create: { contactId: input.contactId },
            update: {},
            select: { id: true },
          });
          const message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              direction: "outbound",
              type: input.type,
              author: input.author,
              authorUserId: input.authorUserId ?? null,
              text: input.text,
              status: "pending",
              idempotencyKey: input.idempotencyKey ?? null,
              raw: { request: input.request } as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          await deps.enqueueOutboundInTx(tx, {
            messageId: message.id,
            conversationId: conversation.id,
          });
          return { messageId: message.id, conversationId: conversation.id, duplicate: false };
        });
      } catch (err) {
        // Same idempotency key sent concurrently: return the winner.
        if (isUniqueViolation(err) && input.idempotencyKey) {
          const existing = await prisma.message.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            select: { id: true, conversationId: true },
          });
          if (existing) {
            return {
              messageId: existing.id,
              conversationId: existing.conversationId,
              duplicate: true,
            };
          }
        }
        throw err;
      }
    },

    async getForSend(messageId) {
      const row = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          status: true,
          waMessageId: true,
          type: true,
          direction: true,
          raw: true,
          conversation: {
            select: {
              id: true,
              lastInboundAt: true,
              contact: { select: { optInAt: true } },
            },
          },
        },
      });
      if (!row || row.direction !== "outbound") return null;
      const raw = (row.raw ?? {}) as { request?: Record<string, unknown> };
      return {
        id: row.id,
        status: row.status,
        waMessageId: row.waMessageId,
        type: row.type,
        conversationId: row.conversation.id,
        lastInboundAt: row.conversation.lastInboundAt,
        contactOptInAt: row.conversation.contact.optInAt,
        request: raw.request ?? {},
      };
    },

    async markAccepted(messageId, { wamid, response, at }) {
      return prisma.$transaction(async (tx) => {
        const current = await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          select: { raw: true, conversationId: true },
        });
        await tx.message.update({
          where: { id: messageId },
          data: {
            waMessageId: wamid,
            raw: {
              ...((current.raw ?? {}) as Record<string, unknown>),
              response,
            } as Prisma.InputJsonValue,
          },
        });
        await tx.$executeRaw`
          UPDATE conversations
             SET last_message_at = GREATEST(COALESCE(last_message_at, ${at}::timestamptz), ${at}::timestamptz),
                 updated_at = now()
           WHERE id = ${current.conversationId}::uuid`;

        // Statuses may arrive before we stored the wamid (webhook faster than this
        // write): link them and apply them in order, forward-only.
        const events = await tx.messageStatusEvent.findMany({
          where: { waMessageId: wamid },
          select: { id: true, status: true, occurredAt: true, errors: true },
        });
        events.sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
            (a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0),
        );
        let applied = 0;
        for (const event of events) {
          await tx.messageStatusEvent.update({
            where: { id: event.id },
            data: { messageId },
          });
          const next = toMessageStatus(event.status);
          if (!next) continue;
          const firstError = Array.isArray(event.errors)
            ? (event.errors[0] as { code?: number; title?: string } | undefined)
            : undefined;
          const updated = await tx.message.updateMany({
            where: { id: messageId, status: { in: allowedPreviousStatuses(next) } },
            data: {
              status: next,
              statusAt: event.occurredAt ?? at,
              ...(next === "failed" && firstError?.code !== undefined
                ? {
                    errorCode: String(firstError.code),
                    errorMessage: firstError.title ?? null,
                  }
                : {}),
            },
          });
          applied += updated.count;
        }
        return { appliedStatuses: applied };
      });
    },

    async markFailed(messageId, errorCode, errorMessage) {
      await prisma.message.updateMany({
        where: { id: messageId, status: "pending" },
        data: {
          status: "failed",
          statusAt: new Date(),
          errorCode,
          errorMessage: errorMessage.slice(0, 2_000),
        },
      });
    },
  };
}
