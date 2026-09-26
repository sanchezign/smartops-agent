import { graphRequest, GraphApiError, type GraphApiConfig } from "./graph-api.js";

/**
 * WhatsApp outbound messages (Meta docs: messages/send-messages):
 *   POST {graph}/{version}/{PHONE_NUMBER_ID}/messages
 * Phone recipients use "to"; BSUID-only recipients use "recipient" (supported since
 * July 2026). Errors are classified into permanent vs retryable categories.
 */

export type SendRecipient = { waId: string } | { bsuid: string };

export interface TemplateParameter {
  type: "text";
  text: string;
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters: TemplateParameter[];
}

export type SendContent =
  | { kind: "text"; body: string; previewUrl?: boolean }
  | { kind: "template"; name: string; languageCode: string; components?: TemplateComponent[] };

export interface SendResult {
  wamid: string;
  /** Templates: accepted | held_for_quality_assessment | paused. */
  messageStatus: string | null;
  waId: string | null;
  userId: string | null;
}

export type SendErrorCategory =
  | "window_closed"
  | "recipient_unreachable"
  | "template_invalid"
  | "bad_request"
  | "unauthorized"
  | "account_restricted"
  | "rate_limited"
  | "transient"
  /** The recipient opted out of marketing messages via WhatsApp's own control (131050). */
  | "recipient_opted_out";

export class WhatsAppSendError extends Error {
  constructor(
    public readonly category: SendErrorCategory,
    public readonly retryable: boolean,
    message: string,
    public readonly metaCode?: number,
    public readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WhatsAppSendError";
  }
}

/** Meta error code / HTTP status → category + retryability (pure, unit tested). */
export function classifySendError(
  metaCode: number | undefined,
  httpStatus: number | undefined,
): { category: SendErrorCategory; retryable: boolean } {
  switch (metaCode) {
    case 131047:
      return { category: "window_closed", retryable: false };
    case 131026:
    case 131030:
      return { category: "recipient_unreachable", retryable: false };
    case 100:
    case 131008:
    case 131009:
    case 131051:
      return { category: "bad_request", retryable: false };
    case 190:
    case 104:
      return { category: "unauthorized", retryable: false };
    case 368:
    case 131031:
      return { category: "account_restricted", retryable: false };
    case 131050:
      return { category: "recipient_opted_out", retryable: false };
    case 130429:
    case 131056:
      return { category: "rate_limited", retryable: true };
    case 1:
    case 2:
    case 131000:
      return { category: "transient", retryable: true };
  }
  if (metaCode !== undefined && metaCode >= 132000 && metaCode < 133000) {
    return { category: "template_invalid", retryable: false };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { category: "unauthorized", retryable: false };
  }
  if (httpStatus === 429) return { category: "rate_limited", retryable: true };
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return { category: "bad_request", retryable: false };
  }
  return { category: "transient", retryable: true };
}

/** Request body for POST /messages (pure). Never contains the access token. */
export function buildSendPayload(
  recipient: SendRecipient,
  content: SendContent,
  options: { replyToWamid?: string } = {},
): Record<string, unknown> {
  const target = "waId" in recipient ? { to: recipient.waId } : { recipient: recipient.bsuid };
  const context = options.replyToWamid ? { context: { message_id: options.replyToWamid } } : {};
  if (content.kind === "text") {
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...target,
      ...context,
      type: "text",
      text: { body: content.body, preview_url: content.previewUrl ?? false },
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...target,
    ...context,
    type: "template",
    template: {
      name: content.name,
      language: { code: content.languageCode },
      ...(content.components?.length ? { components: content.components } : {}),
    },
  };
}

export interface WhatsAppSendClient {
  send(payload: Record<string, unknown>): Promise<SendResult>;
}

export function createWhatsAppSendClient(deps: {
  graph: GraphApiConfig;
  phoneNumberId: string;
}): WhatsAppSendClient {
  return {
    async send(payload) {
      let response: {
        messages?: { id?: string; message_status?: string }[];
        contacts?: { wa_id?: string; user_id?: string }[];
      };
      try {
        response = await graphRequest(
          deps.graph,
          "POST",
          `${deps.phoneNumberId}/messages`,
          payload,
        );
      } catch (err) {
        if (err instanceof GraphApiError) {
          const { category, retryable } = classifySendError(err.code, err.httpStatus);
          throw new WhatsAppSendError(category, retryable, err.message, err.code, err.httpStatus, {
            cause: err,
          });
        }
        // Timeout / network: the message MAY have been accepted. Retrying could duplicate
        // it; WhatsApp has no idempotency key, so we accept that small risk (logged).
        throw new WhatsAppSendError(
          "transient",
          true,
          `Send request failed: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          undefined,
          { cause: err },
        );
      }
      const wamid = response.messages?.[0]?.id;
      if (!wamid) {
        throw new WhatsAppSendError("transient", true, "Send response without a message id");
      }
      return {
        wamid,
        messageStatus: response.messages?.[0]?.message_status ?? null,
        waId: response.contacts?.[0]?.wa_id ?? null,
        userId: response.contacts?.[0]?.user_id ?? null,
      };
    },
  };
}
