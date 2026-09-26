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
    /** Business-scoped user id of the recipient (BSUID). */
    recipient_user_id: z.string().optional(),
    errors: z.array(whatsappErrorSchema).optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const mediaSchema = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
    voice: z.boolean().optional(),
  })
  .loose();

export const whatsappContactSchema = z
  .object({
    wa_id: z.string().optional(),
    /** Business-scoped user id (BSUID). */
    user_id: z.string().optional(),
    profile: z
      .object({ name: z.string().optional(), username: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

export const whatsappMessageSchema = z
  .object({
    id: z.string(),
    /** Phone number (wa_id). May be omitted, or carry a BSUID, for users with a username. */
    from: z.string().optional(),
    /** Business-scoped user id (BSUID) of the sender. */
    from_user_id: z.string().optional(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).loose().optional(),
    image: mediaSchema.optional(),
    document: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    video: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
    button: z.object({ text: z.string().optional() }).loose().optional(),
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ title: z.string().optional() }).loose().optional(),
        list_reply: z.object({ title: z.string().optional() }).loose().optional(),
      })
      .loose()
      .optional(),
    reaction: z.object({ emoji: z.string().optional() }).loose().optional(),
    location: z
      .object({
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .loose()
      .optional(),
    system: z.object({ body: z.string().optional() }).loose().optional(),
    errors: z.array(whatsappErrorSchema).optional(),
  })
  .loose();

/**
 * Coexistence echo (field `smb_message_echoes`, phase 7): a message the BUSINESS sent from
 * the WhatsApp Business app or a companion device. Same body as a message plus `to`
 * (the contact's phone; no BSUID in Meta's reference), and `revoke` / `edit` types.
 */
export const whatsappEchoSchema = whatsappMessageSchema.extend({
  to: z.string(),
  revoke: z.object({ original_message_id: z.string() }).loose().optional(),
  edit: z
    .object({ original_message_id: z.string(), message: z.unknown().optional() })
    .loose()
    .optional(),
});
export type WhatsAppEcho = z.infer<typeof whatsappEchoSchema>;

/**
 * user_preferences webhook (Meta reference, 2026-09-26): a WhatsApp user stopped or
 * resumed MARKETING messages using WhatsApp's own control. Informational for us (we send
 * no marketing messages) — kept for completeness and future template use.
 */
export const whatsappUserPreferenceSchema = z
  .object({
    wa_id: z.string(),
    category: z.string(),
    value: z.string(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .loose();
export type WhatsAppUserPreference = z.infer<typeof whatsappUserPreferenceSchema>;

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
    // Items are validated one by one by the parser: a malformed item must not
    // invalidate the rest of the delivery.
    contacts: z.array(z.unknown()).optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
    message_echoes: z.array(z.unknown()).optional(),
    user_preferences: z.array(z.unknown()).optional(),
    errors: z.array(z.unknown()).optional(),
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
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;
export type WhatsAppStatus = z.infer<typeof whatsappStatusSchema>;
export type WhatsAppContact = z.infer<typeof whatsappContactSchema>;
