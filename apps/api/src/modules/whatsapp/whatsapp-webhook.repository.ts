import type { PrismaClient } from "../../common/db.js";
import { Prisma } from "../../generated/prisma/client.js";

export interface SaveWebhookEventInput {
  bodySha256: string;
  payload: unknown;
}

export type SaveWebhookEventResult =
  | { duplicate: false; id: string }
  /** Identical body already stored (Meta re-delivery): unique (provider, body_sha256). */
  | { duplicate: true };

export interface WhatsAppWebhookRepository {
  saveEvent(input: SaveWebhookEventInput): Promise<SaveWebhookEventResult>;
}

export function createWhatsAppWebhookRepository(prisma: PrismaClient): WhatsAppWebhookRepository {
  return {
    async saveEvent({ bodySha256, payload }) {
      try {
        const event = await prisma.webhookEvent.create({
          data: {
            provider: "whatsapp",
            bodySha256,
            payload: payload as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        return { duplicate: false, id: event.id };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return { duplicate: true };
        }
        throw err;
      }
    },
  };
}
