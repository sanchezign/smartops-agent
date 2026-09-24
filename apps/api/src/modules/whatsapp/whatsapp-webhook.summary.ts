import { maskPhone, maskPhonesInText, maskUserId } from "../../common/phone.js";
import { parseWhatsAppWebhook, type ParsedWebhook } from "./whatsapp-webhook.parser.js";
import type { WhatsAppError } from "./whatsapp-webhook.schemas.js";

/**
 * Log-safe summary of a webhook delivery: ids, types, statuses and Meta error codes.
 * Phone numbers and BSUIDs are masked; message bodies, names and media ids are never
 * included. Pure — unit tested.
 */

export interface SummaryError {
  code: number;
  title?: string;
  message?: string;
  details?: string;
  href?: string;
}

export type WebhookSummaryItem =
  | {
      kind: "status";
      field: string;
      wamid: string;
      status: string;
      recipient: string;
      recipientUserId?: string;
      timestamp?: string;
      errors: SummaryError[];
    }
  | {
      kind: "message";
      field: string;
      wamid: string;
      type: string;
      from: string;
      fromUserId?: string;
    }
  | { kind: "error"; field: string; errors: SummaryError[] }
  | { kind: "invalid_items"; field: string; items: { kind: string; index: number }[] }
  | { kind: "other_field"; field: string };

export interface WebhookSummary {
  /** false when the body is valid JSON but not a recognizable WhatsApp webhook. */
  recognized: boolean;
  object?: string;
  items: WebhookSummaryItem[];
}

export function toSummaryErrors(errors: WhatsAppError[] | undefined): SummaryError[] {
  return (errors ?? []).map((e) => ({
    code: e.code,
    ...(e.title === undefined ? {} : { title: maskPhonesInText(e.title) }),
    ...(e.message === undefined || e.message === e.title
      ? {}
      : { message: maskPhonesInText(e.message) }),
    ...(e.error_data?.details === undefined
      ? {}
      : { details: maskPhonesInText(e.error_data.details) }),
    ...(e.href === undefined ? {} : { href: e.href }),
  }));
}

export function summarizeParsedWebhook(parsed: ParsedWebhook): WebhookSummary {
  if (!parsed.recognized) return { recognized: false, items: [] };

  const items: WebhookSummaryItem[] = [];
  for (const change of parsed.changes) {
    const { field } = change;
    if (field !== "messages") {
      items.push({ kind: "other_field", field });
      continue;
    }
    for (const status of change.statuses) {
      items.push({
        kind: "status",
        field,
        wamid: status.waMessageId,
        status: status.status,
        recipient: maskPhone(status.recipientWaId),
        ...(status.recipientUserId ? { recipientUserId: maskUserId(status.recipientUserId) } : {}),
        ...(status.timestamp
          ? { timestamp: String(Math.floor(status.timestamp.getTime() / 1000)) }
          : {}),
        errors: toSummaryErrors(status.errors),
      });
    }
    for (const message of change.messages) {
      items.push({
        kind: "message",
        field,
        wamid: message.waMessageId,
        type: message.waType,
        from: maskPhone(message.fromWaId),
        ...(message.fromUserId ? { fromUserId: maskUserId(message.fromUserId) } : {}),
      });
    }
    if (change.errors.length > 0) {
      items.push({ kind: "error", field, errors: toSummaryErrors(change.errors) });
    }
    if (change.invalidItems.length > 0) {
      items.push({ kind: "invalid_items", field, items: change.invalidItems });
    }
  }
  return { recognized: true, object: parsed.object, items };
}

export function summarizeWhatsAppWebhook(payload: unknown): WebhookSummary {
  return summarizeParsedWebhook(parseWhatsAppWebhook(payload));
}
