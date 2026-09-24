import { z } from "zod";

/**
 * Zod schemas for WhatsApp Cloud API webhooks (field `messages`).
 * Deliberately lenient (`loose`, most fields optional): Meta adds fields over time
 * and a strict schema must never make us drop a delivery. Phase 3 / milestone 2
 * tightens the per-message-type schemas used by the worker.
 * Reference: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks
 */

export const verifyQuerySchema = z.object({
  "hub.mode": z.string(),
  "hub.verify_token": z.string(),
  "hub.challenge": z.string().min(1).max(256),
});

/** Error object used in failed statuses and value-level (out-of-band) errors. */
export const whatsappErrorSchema = z
  .object({
    code: z.number(),
    title: z.string().optional(),
    message: z.string().optional(),
    error_data: z.object({ details: z.string().optional() }).loose().optional(),
    href: z.string().optional(),
  })
  .loose();

export const whatsappStatusSchema = z
  .object({
    /** wamid of the outbound message this status refers to. */
    id: z.string(),
    /** sent | delivered | read | played | failed (kept as string: tolerate new values). */
    status: z.string(),
    timestamp: z.string().optional(),
    recipient_id: z.string().optional(),
    errors: z.array(whatsappErrorSchema).optional(),
  })
  .loose();

export const whatsappMessageSchema = z
  .object({
    id: z.string(),
    from: z.string().optional(),
    timestamp: z.string().optional(),
    type: z.string(),
  })
  .loose();

export const whatsappChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: z.string().optional(),
      })
      .loose()
      .optional(),
    messages: z.array(whatsappMessageSchema).optional(),
    statuses: z.array(whatsappStatusSchema).optional(),
    errors: z.array(whatsappErrorSchema).optional(),
  })
  .loose();

export const whatsappWebhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          id: z.string(),
          changes: z.array(
            z.object({ field: z.string(), value: whatsappChangeValueSchema }).loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

export type WhatsAppWebhook = z.infer<typeof whatsappWebhookSchema>;
export type WhatsAppError = z.infer<typeof whatsappErrorSchema>;
