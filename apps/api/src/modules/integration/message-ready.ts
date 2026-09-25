import type { Prisma } from "../../generated/prisma/client.js";

/**
 * "message.ready" outbox events (phase 6, ADR-015). A message is READY when nothing else
 * has to happen before it can be classified: text ingested; media stored and needing no
 * more work (image, PDF); media rejected/failed/skipped; voice note transcribed (or not);
 * document converted (or not). The event is created in the SAME transaction as that
 * transition and its delivery job is enqueued in it too — if n8n is down, nothing is lost.
 * dedupeKey "message.ready:<messageId>" makes it at-most-once per message; delivery is
 * at-least-once, so every endpoint n8n calls is idempotent.
 */

export const MESSAGE_READY = "message.ready";
export const MESSAGE_READY_VERSION = 1;

/** What n8n receives: ids and routing facts only, never the message content (PII). */
export interface MessageReadyPayload {
  version: typeof MESSAGE_READY_VERSION;
  type: typeof MESSAGE_READY;
  eventId: string;
  messageId: string;
  conversationId: string;
  contactId: string;
  contactKind: string;
  messageType: string;
  receivedAt: string;
}

export type EnqueueDeliveryInTx = (tx: Prisma.TransactionClient, eventId: string) => Promise<void>;

export type EmitMessageReadyInTx = (
  tx: Prisma.TransactionClient,
  ref: { messageId: string } | { mediaFileId: string },
) => Promise<{ created: boolean; eventId: string | null }>;

export function createEmitMessageReadyInTx(enqueueInTx: EnqueueDeliveryInTx): EmitMessageReadyInTx {
  return async (tx, ref) => {
    const message = await tx.message.findFirst({
      where: "messageId" in ref ? { id: ref.messageId } : { mediaFileId: ref.mediaFileId },
      select: {
        id: true,
        direction: true,
        type: true,
        createdAt: true,
        waTimestamp: true,
        conversationId: true,
        conversation: { select: { contact: { select: { id: true, kind: true } } } },
      },
    });
    if (!message || message.direction !== "inbound") return { created: false, eventId: null };

    const dedupeKey = `${MESSAGE_READY}:${message.id}`;
    const [created] = await tx.integrationEvent.createManyAndReturn({
      data: [
        {
          type: MESSAGE_READY,
          messageId: message.id,
          dedupeKey,
          payload: {},
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!created) return { created: false, eventId: null };

    const payload: MessageReadyPayload = {
      version: MESSAGE_READY_VERSION,
      type: MESSAGE_READY,
      eventId: created.id,
      messageId: message.id,
      conversationId: message.conversationId,
      contactId: message.conversation.contact.id,
      contactKind: message.conversation.contact.kind,
      messageType: message.type,
      receivedAt: (message.waTimestamp ?? message.createdAt).toISOString(),
    };
    await tx.integrationEvent.update({
      where: { id: created.id },
      data: { payload: payload as unknown as Prisma.InputJsonValue },
    });
    await enqueueInTx(tx, created.id);
    return { created: true, eventId: created.id };
  };
}
