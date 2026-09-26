import { fakeWamid, waTimestamp } from "./ids.js";

/**
 * Builders for WhatsApp Cloud API webhook payloads (field `messages`), shaped like
 * Meta's docs and the fixtures in test/fixtures/whatsapp. Pure — unit tested against
 * the production parser so the simulator cannot drift from what the API accepts.
 */

export interface SimBusiness {
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
}

export interface SimContact {
  /** Phone number (digits). Null = BSUID-only user (Meta omits wa_id / from). */
  waId: string | null;
  /** Business-scoped user id. */
  bsuid: string | null;
  name?: string | null;
  username?: string | null;
}

export interface SimMedia {
  id: string;
  mimeType: string;
  sha256: string;
  filename?: string | null;
  caption?: string | null;
  voice?: boolean;
}

export type SimMessage =
  | { type: "text"; body: string }
  | { type: "image" | "document" | "audio" | "video" | "sticker"; media: SimMedia }
  | { type: "interactive"; title: string };

export interface SimError {
  code: number;
  title?: string;
  details?: string;
}

/** Titles Meta uses for common delivery errors (for realistic failed statuses). */
export const KNOWN_ERRORS: Record<number, { title: string; details: string }> = {
  130429: {
    title: "Rate limit hit",
    details: "Cloud API message throughput has been reached.",
  },
  131026: {
    title: "Message undeliverable",
    details: "Unable to deliver message. The recipient may not be a WhatsApp user.",
  },
  131030: {
    title: "Recipient phone number not in allowed list",
    details:
      "Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.",
  },
  131047: {
    title: "Re-engagement message",
    details:
      "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
  },
  131049: {
    title: "This message was not delivered to maintain healthy ecosystem engagement.",
    details:
      "In order to maintain a healthy ecosystem engagement, the message failed to be delivered.",
  },
  131051: { title: "Message type unknown", details: "Message type is currently not supported." },
};

export function toMetaError(error: SimError) {
  const known = KNOWN_ERRORS[error.code];
  const title = error.title ?? known?.title ?? "Unknown error";
  return {
    code: error.code,
    title,
    message: title,
    error_data: { details: error.details ?? known?.details ?? title },
    href: "https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes",
  };
}

function envelope(
  business: SimBusiness,
  value: Record<string, unknown>,
  field: "messages" | "smb_message_echoes" = "messages",
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: business.wabaId,
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: business.displayPhoneNumber,
                phone_number_id: business.phoneNumberId,
              },
              ...value,
            },
            field,
          },
        ],
      },
    ],
  };
}

function contactBlock(contact: SimContact) {
  return {
    profile: {
      ...(contact.name ? { name: contact.name } : {}),
      ...(contact.username ? { username: contact.username } : {}),
    },
    ...(contact.waId ? { wa_id: contact.waId } : {}),
    ...(contact.bsuid ? { user_id: contact.bsuid } : {}),
  };
}

function messageBody(message: SimMessage): Record<string, unknown> {
  switch (message.type) {
    case "text":
      return { text: { body: message.body } };
    case "interactive":
      return {
        interactive: {
          type: "button_reply",
          button_reply: { id: "sim-button", title: message.title },
        },
      };
    default: {
      const { media } = message;
      return {
        [message.type]: {
          ...(media.caption ? { caption: media.caption } : {}),
          ...(media.filename && message.type === "document" ? { filename: media.filename } : {}),
          mime_type: media.mimeType,
          sha256: media.sha256,
          id: media.id,
          ...(message.type === "audio" && media.voice !== undefined ? { voice: media.voice } : {}),
        },
      };
    }
  }
}

/** Inbound message webhook (a contact writes to the business number). */
export function buildInboundMessage(
  business: SimBusiness,
  contact: SimContact,
  message: SimMessage,
  options: { wamid?: string; at?: Date } = {},
) {
  if (!contact.waId && !contact.bsuid) throw new Error("contact needs a waId or a bsuid");
  const wamid = options.wamid ?? fakeWamid();
  const payload = envelope(business, {
    contacts: [contactBlock(contact)],
    messages: [
      {
        ...(contact.waId ? { from: contact.waId } : {}),
        ...(contact.bsuid ? { from_user_id: contact.bsuid } : {}),
        id: wamid,
        timestamp: waTimestamp(options.at),
        type: message.type,
        ...messageBody(message),
      },
    ],
  });
  return { wamid, payload };
}

export type SimStatusValue = "sent" | "delivered" | "read" | "played" | "failed";

/** Status webhook for an outbound message (sent / delivered / read / failed). */
export function buildStatus(
  business: SimBusiness,
  input: {
    wamid: string;
    status: SimStatusValue;
    recipient: SimContact;
    errors?: SimError[];
    category?: "utility" | "marketing" | "authentication" | "service";
    at?: Date;
  },
) {
  const { recipient } = input;
  const recipientId = recipient.waId ?? recipient.bsuid;
  if (!recipientId) throw new Error("recipient needs a waId or a bsuid");
  const withPricing =
    input.status === "sent" || input.status === "delivered" || input.status === "read";

  return envelope(business, {
    statuses: [
      {
        id: input.wamid,
        status: input.status,
        timestamp: waTimestamp(input.at),
        recipient_id: recipientId,
        ...(recipient.bsuid ? { recipient_user_id: recipient.bsuid } : {}),
        ...(withPricing
          ? {
              pricing: {
                billable: input.category !== "service",
                pricing_model: "PMP",
                category: input.category ?? "service",
              },
            }
          : {}),
        ...(input.status === "failed"
          ? { errors: (input.errors ?? [{ code: 131026 }]).map(toMetaError) }
          : {}),
      },
    ],
  });
}

export type SimEcho =
  | SimMessage
  | { type: "revoke"; originalWamid: string }
  | { type: "edit"; originalWamid: string; body: string };

/**
 * Coexistence echo (field `smb_message_echoes`, phase 7): a PERSON wrote to the contact
 * from the WhatsApp Business app. Shaped like Meta's reference: from = business display
 * number, to = the contact's PHONE (no BSUID), same message bodies + revoke / edit.
 */
export function buildMessageEcho(
  business: SimBusiness,
  to: string,
  echo: SimEcho,
  options: { wamid?: string; at?: Date } = {},
) {
  const wamid = options.wamid ?? fakeWamid();
  let body: Record<string, unknown>;
  if (echo.type === "revoke") {
    body = { revoke: { original_message_id: echo.originalWamid } };
  } else if (echo.type === "edit") {
    body = {
      edit: {
        original_message_id: echo.originalWamid,
        message: { context: { id: "M0" }, type: "text", text: { body: echo.body } },
      },
    };
  } else {
    body = messageBody(echo);
  }
  const payload = envelope(
    business,
    {
      message_echoes: [
        {
          from: business.displayPhoneNumber,
          to,
          id: wamid,
          timestamp: waTimestamp(options.at),
          type: echo.type,
          ...body,
        },
      ],
    },
    "smb_message_echoes",
  );
  return { wamid, payload };
}
