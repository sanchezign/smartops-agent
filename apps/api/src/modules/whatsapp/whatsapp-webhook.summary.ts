import { maskPhone, maskPhonesInText } from "../../common/phone.js";
import { whatsappWebhookSchema, type WhatsAppError } from "./whatsapp-webhook.schemas.js";

/**
 * Log-safe summary of a webhook delivery: ids, types, statuses and Meta error codes.
 * Phone numbers are masked; message bodies, names and media ids are never included.
 * Pure — used for diagnostics logging and unit tested.
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
      timestamp?: string;
      errors: SummaryError[];
    }
  | { kind: "message"; field: string; wamid: string; type: string; from: string }
  | { kind: "error"; field: string; errors: SummaryError[] }
  | { kind: "other_field"; field: string };

export interface WebhookSummary {
  /** false when the body is valid JSON but not a recognizable WhatsApp webhook. */
  recognized: boolean;
  object?: string;
  items: WebhookSummaryItem[];
}

function toSummaryErrors(errors: WhatsAppError[] | undefined): SummaryError[] {
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

export function summarizeWhatsAppWebhook(payload: unknown): WebhookSummary {
  const parsed = whatsappWebhookSchema.safeParse(payload);
  if (!parsed.success) return { recognized: false, items: [] };

  const items: WebhookSummaryItem[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const { field, value } = change;
      if (field !== "messages") {
        items.push({ kind: "other_field", field });
        continue;
      }
      for (const status of value.statuses ?? []) {
        items.push({
          kind: "status",
          field,
          wamid: status.id,
          status: status.status,
          recipient: maskPhone(status.recipient_id),
          ...(status.timestamp === undefined ? {} : { timestamp: status.timestamp }),
          errors: toSummaryErrors(status.errors),
        });
      }
      for (const message of value.messages ?? []) {
        items.push({
          kind: "message",
          field,
          wamid: message.id,
          type: message.type,
          from: maskPhone(message.from),
        });
      }
      if (value.errors?.length) {
        items.push({ kind: "error", field, errors: toSummaryErrors(value.errors) });
      }
    }
  }
  return { recognized: true, object: parsed.data.object, items };
}
