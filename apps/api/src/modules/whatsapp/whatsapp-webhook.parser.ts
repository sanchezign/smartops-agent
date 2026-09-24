import type { MessageType } from "../../generated/prisma/enums.js";
import {
  whatsappContactSchema,
  whatsappErrorSchema,
  whatsappMessageSchema,
  whatsappStatusSchema,
  whatsappWebhookSchema,
  type WhatsAppContact,
  type WhatsAppError,
  type WhatsAppMessage,
} from "./whatsapp-webhook.schemas.js";

/**
 * Turns a raw WhatsApp webhook payload into normalized objects. Pure (no I/O).
 * Lenient by design: unknown fields are ignored, unknown message types become
 * `unsupported`, and an item that fails validation is reported in `invalidItems`
 * instead of invalidating the whole delivery.
 */

export interface ParsedMedia {
  waMediaId: string;
  mimeType: string | null;
  sha256: string | null;
  filename: string | null;
}

export interface ParsedInboundMessage {
  waMessageId: string;
  /** Sender phone number (wa_id). Null when Meta sent only a BSUID. */
  fromWaId: string | null;
  /** Sender business-scoped user id (BSUID). */
  fromUserId: string | null;
  contactName: string | null;
  username: string | null;
  timestamp: Date | null;
  type: MessageType;
  /** Original Meta type (e.g. "system", "order"), useful when type = unsupported. */
  waType: string;
  /** Text body, caption, button/list title, reaction emoji or location label. */
  text: string | null;
  media: ParsedMedia | null;
  errors: WhatsAppError[];
  raw: WhatsAppMessage;
}

export interface ParsedStatus {
  waMessageId: string;
  /** Raw Meta status (sent | delivered | read | played | failed | …). */
  status: string;
  timestamp: Date | null;
  recipientWaId: string | null;
  recipientUserId: string | null;
  errors: WhatsAppError[];
  pricing: Record<string, unknown> | null;
}

export interface ParsedChange {
  field: string;
  phoneNumberId: string | null;
  messages: ParsedInboundMessage[];
  statuses: ParsedStatus[];
  /** Value-level (out-of-band) errors. */
  errors: WhatsAppError[];
  /** Items that failed validation (kind + index) — logged, never fatal. */
  invalidItems: { kind: "message" | "status" | "contact" | "error"; index: number }[];
}

export type ParsedWebhook =
  { recognized: false } | { recognized: true; object: string; changes: ParsedChange[] };

const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const DIRECT_TYPES: Record<string, MessageType> = {
  text: "text",
  image: "image",
  document: "document",
  audio: "audio",
  video: "video",
  sticker: "sticker",
  location: "location",
  contacts: "contacts",
  interactive: "interactive",
  button: "button",
  reaction: "reaction",
};

/** WhatsApp timestamps are unix seconds as strings. */
export function parseWaTimestamp(value: string | undefined): Date | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isMediaType(type: string): type is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(type);
}

function messageText(message: WhatsAppMessage): string | null {
  switch (message.type) {
    case "text":
      return message.text?.body ?? null;
    case "button":
      return message.button?.text ?? null;
    case "interactive":
      return (
        message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? null
      );
    case "reaction":
      return message.reaction?.emoji ?? null;
    case "location": {
      const loc = message.location;
      if (!loc) return null;
      const label = [loc.name, loc.address].filter(Boolean).join(" — ");
      if (label) return label;
      return loc.latitude !== undefined && loc.longitude !== undefined
        ? `${loc.latitude},${loc.longitude}`
        : null;
    }
    case "system":
      return message.system?.body ?? null;
    default:
      if (isMediaType(message.type)) return message[message.type]?.caption ?? null;
      return null;
  }
}

function messageMedia(message: WhatsAppMessage): ParsedMedia | null {
  if (!isMediaType(message.type)) return null;
  const media = message[message.type];
  if (!media) return null;
  return {
    waMediaId: media.id,
    mimeType: media.mime_type ?? null,
    sha256: media.sha256 ?? null,
    filename: media.filename ?? null,
  };
}

function findContact(
  contacts: WhatsAppContact[],
  message: WhatsAppMessage,
): WhatsAppContact | undefined {
  const match = contacts.find(
    (c) =>
      (message.from_user_id !== undefined && c.user_id === message.from_user_id) ||
      (message.from !== undefined && c.wa_id === message.from),
  );
  return match ?? (contacts.length === 1 ? contacts[0] : undefined);
}

/** A BSUID looks like "US.13491208655302741918"; a phone number is digits only. */
export function isBsuid(value: string): boolean {
  return /^[A-Z]{2}\.[A-Za-z0-9]+$/.test(value);
}

function normalizeMessage(message: WhatsAppMessage, contacts: WhatsAppContact[]) {
  const contact = findContact(contacts, message);
  // From mid-2026 `from` / `wa_id` may carry a BSUID instead of a phone number.
  const rawFrom = message.from ?? contact?.wa_id ?? null;
  const fromIsBsuid = rawFrom !== null && isBsuid(rawFrom);
  const fromUserId = message.from_user_id ?? contact?.user_id ?? (fromIsBsuid ? rawFrom : null);
  const type = DIRECT_TYPES[message.type] ?? "unsupported";

  const parsed: ParsedInboundMessage = {
    waMessageId: message.id,
    fromWaId: fromIsBsuid ? null : rawFrom,
    fromUserId,
    contactName: contact?.profile?.name ?? null,
    username: contact?.profile?.username ?? null,
    timestamp: parseWaTimestamp(message.timestamp),
    type,
    waType: message.type,
    text: messageText(message),
    media: messageMedia(message),
    errors: message.errors ?? [],
    raw: message,
  };
  return parsed;
}

function parseItems<T>(
  items: unknown[] | undefined,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  kind: ParsedChange["invalidItems"][number]["kind"],
  invalid: ParsedChange["invalidItems"],
): T[] {
  const out: T[] = [];
  (items ?? []).forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
    else invalid.push({ kind, index });
  });
  return out;
}

export function parseWhatsAppWebhook(payload: unknown): ParsedWebhook {
  const envelope = whatsappWebhookSchema.safeParse(payload);
  if (!envelope.success) return { recognized: false };

  const changes: ParsedChange[] = [];
  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      const invalidItems: ParsedChange["invalidItems"] = [];
      const contacts = parseItems(value.contacts, whatsappContactSchema, "contact", invalidItems);
      const messages = parseItems(value.messages, whatsappMessageSchema, "message", invalidItems);
      const statuses = parseItems(value.statuses, whatsappStatusSchema, "status", invalidItems);
      const errors = parseItems(value.errors, whatsappErrorSchema, "error", invalidItems);

      changes.push({
        field: change.field,
        phoneNumberId: value.metadata?.phone_number_id ?? null,
        messages: messages.map((m) => normalizeMessage(m, contacts)),
        statuses: statuses.map((s) => ({
          waMessageId: s.id,
          status: s.status,
          timestamp: parseWaTimestamp(s.timestamp),
          recipientWaId:
            s.recipient_id !== undefined && !isBsuid(s.recipient_id) ? s.recipient_id : null,
          recipientUserId:
            s.recipient_user_id ??
            (s.recipient_id !== undefined && isBsuid(s.recipient_id) ? s.recipient_id : null),
          errors: s.errors ?? [],
          pricing: s.pricing ?? null,
        })),
        errors,
        invalidItems,
      });
    }
  }
  return { recognized: true, object: envelope.data.object, changes };
}
