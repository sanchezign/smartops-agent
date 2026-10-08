import type { ChatMessage, ContactSummary } from "./types";

/**
 * Conversation helpers (phase 9 M3). Since phase 13 the words live in the "conversations"
 * messages; these functions only decide WHICH text applies (codes, emojis, names).
 */

export type WhoAnswers = "bot" | "human" | "opted_out";

/**
 * Who answers this chat (the badge). An opted-out contact wins: the bot sends it nothing,
 * whatever the mode says (ADR-017).
 */
export function whoAnswers(input: {
  mode: "bot" | "human";
  contact: Pick<ContactSummary, "optOutAt">;
}): WhoAnswers {
  if (input.contact.optOutAt) return "opted_out";
  return input.mode;
}

/** Decorative emoji of each badge (the text is read, from "conversations.who"). */
export const WHO_EMOJI: Record<WhoAnswers, string> = { bot: "🤖", human: "👤", opted_out: "⛔" };

export function contactName(
  contact: Pick<ContactSummary, "name" | "waId" | "username">,
  fallback: string,
): string {
  return contact.name ?? contact.username ?? (contact.waId ? `+${contact.waId}` : fallback);
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The supplier name, unless the contact is already called like it ("Eléctrica Oriental"). */
export function supplierSuffix(contact: Pick<ContactSummary, "name" | "supplier">): string | null {
  if (!contact.supplier) return null;
  const name = contact.name ? fold(contact.name) : "";
  return name && fold(contact.supplier.name).startsWith(name) ? null : contact.supplier.name;
}

const pick = <T extends string>(values: readonly T[], value: string, fallback: T): T =>
  (values as readonly string[]).includes(value) ? (value as T) : fallback;

/** Outbound delivery states with a label ("conversations.status"). */
export const STATUSES = ["pending", "sent", "delivered", "read", "failed", "canceled"] as const;
export type OutboundStatus = (typeof STATUSES)[number];
export const isLabeledStatus = (status: string): status is OutboundStatus =>
  (STATUSES as readonly string[]).includes(status);

/**
 * How a bubble marks its delivery state (phase 14 #9): only a send that really failed is an
 * error; "canceled" (a person took over, so the bot reply was withdrawn) is expected and is shown
 * neutral.
 */
export function statusTone(status: string): "failed" | "canceled" | "normal" {
  return status === "failed" ? "failed" : status === "canceled" ? "canceled" : "normal";
}

const TYPES = [
  "image",
  "audio",
  "document",
  "video",
  "sticker",
  "location",
  "contacts",
  "reaction",
] as const;
export type PreviewType = (typeof TYPES)[number] | "other";

/** The inbox preview line: the message's own snippet, else the key of its type's label. */
export function preview(message: {
  type: string;
  snippet: string | null;
}): { snippet: string } | { type: PreviewType } {
  return message.snippet !== null
    ? { snippet: message.snippet }
    : { type: pick<PreviewType>(TYPES, message.type, "other") };
}

/** Who wrote an outbound message, for the bubble: emoji + label key, or the person's name. */
export function outboundAuthor(message: Pick<ChatMessage, "author" | "authorName" | "purpose">): {
  emoji: string;
  key: "compliance" | "bot" | "phone" | null;
  name?: string;
} {
  if (message.purpose === "compliance") return { emoji: "🤖", key: "compliance" };
  if (message.author === "bot") return { emoji: "🤖", key: "bot" };
  return message.authorName
    ? { emoji: "👤", key: null, name: message.authorName }
    : { emoji: "👤", key: "phone" };
}

const MEDIA_STATES = ["pending", "skipped", "rejected", "failed"] as const;
/** Why an attachment is not shown ("conversations.media.unavailable"). */
export const mediaUnavailableKey = (status: string) =>
  pick<(typeof MEDIA_STATES)[number] | "other">(MEDIA_STATES, status, "other");
