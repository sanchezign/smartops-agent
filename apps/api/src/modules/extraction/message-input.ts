import type { LlmContent } from "../../ai/llm-provider.js";
import { normalizeMime } from "../media/media-policy.js";

/**
 * Builds the LLM content for a message (pure). Order is fixed (media first, then text)
 * so the same message always yields the same content (golden-output keys).
 * Untrusted text (message, caption, transcript, converted documents) is wrapped in
 * delimiter tags; any of our tags appearing inside it are neutralized so the text can
 * never "close" its block and pose as instructions or catalog data (ADR-011).
 */

export interface MessageForAi {
  messageType: string;
  /** Text body or media caption. */
  text: string | null;
  transcript: string | null;
  filename: string | null;
  mimeType: string | null;
  media: Uint8Array | null;
  /** Text produced from a spreadsheet/docx (phase 5 M3). */
  documentText?: string | null;
  contactKind: string;
  supplierName: string | null;
}

const OUR_TAGS =
  /<\/?\s*(message_text|voice_transcript|caption|document_text|catalog|context|sheet_sample|product_names)\b[^>]*>/gi;

export function neutralizeTags(untrusted: string): string {
  return untrusted.replace(OUR_TAGS, "[etiqueta eliminada]");
}

function wrap(tag: string, untrusted: string): string {
  return `<${tag}>\n${neutralizeTags(untrusted.trim())}\n</${tag}>`;
}

function contextBlock(message: MessageForAi): string {
  const lines = [
    `message_type: ${message.messageType}`,
    `sender: ${message.contactKind}${message.supplierName ? ` (supplier: ${message.supplierName})` : ""}`,
  ];
  if (message.filename)
    lines.push(`filename: ${message.filename.replace(/[\r\n<>]/g, " ").slice(0, 120)}`);
  return `<context>\n${lines.join("\n")}\n</context>`;
}

export type ContentResult =
  | { ok: true; content: LlmContent[] }
  | {
      ok: false;
      reason: "no_content" | "unsupported_media" | "media_not_ready" | "transcript_not_ready";
    };

/** Classification input: text signals only (media messages are decided by extraction). */
export function buildClassificationContent(message: MessageForAi): ContentResult {
  const blocks: string[] = [contextBlock(message)];
  if (message.messageType === "audio") {
    if (!message.transcript) return { ok: false, reason: "transcript_not_ready" };
    blocks.push(wrap("voice_transcript", message.transcript));
  } else if (message.text) {
    blocks.push(wrap(message.messageType === "text" ? "message_text" : "caption", message.text));
  } else {
    return { ok: false, reason: "no_content" };
  }
  return {
    ok: true,
    content: [{ type: "text", text: blocks.join("\n\n"), fakeKeyText: untrustedKey(message) }],
  };
}

/** The message's own (untrusted) content: the golden-output key for the fake provider. */
function untrustedKey(message: MessageForAi): string {
  return [
    message.documentText,
    message.messageType === "audio" ? message.transcript : null,
    message.text,
  ]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim())
    .join("\n---\n");
}

export function buildExtractionContent(
  message: MessageForAi,
  catalogText: string | null,
): ContentResult {
  const content: LlmContent[] = [];
  const mime = normalizeMime(message.mimeType);

  if (
    message.messageType === "image" ||
    (message.messageType === "document" && mime.startsWith("image/"))
  ) {
    if (!message.media) return { ok: false, reason: "media_not_ready" };
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
      return { ok: false, reason: "unsupported_media" };
    content.push({
      type: "image",
      mediaType: mime as "image/jpeg" | "image/png" | "image/webp",
      data: message.media,
    });
  } else if (message.messageType === "document") {
    if (mime === "application/pdf") {
      if (!message.media) return { ok: false, reason: "media_not_ready" };
      content.push({
        type: "pdf",
        data: message.media,
        ...(message.filename ? { title: message.filename.slice(0, 120) } : {}),
      });
    } else if (!message.documentText) {
      return { ok: false, reason: "unsupported_media" };
    }
  } else if (message.messageType === "audio") {
    if (!message.transcript) return { ok: false, reason: "transcript_not_ready" };
  } else if (message.messageType !== "text" || !message.text) {
    return { ok: false, reason: "no_content" };
  }

  const blocks: string[] = [contextBlock(message)];
  if (message.documentText) blocks.push(wrap("document_text", message.documentText));
  if (message.messageType === "audio" && message.transcript)
    blocks.push(wrap("voice_transcript", message.transcript));
  if (message.text)
    blocks.push(wrap(message.messageType === "text" ? "message_text" : "caption", message.text));
  blocks.push(
    catalogText
      ? `<catalog>\n${catalogText}\n</catalog>`
      : "<catalog>\n(the supplier has no products in the catalog yet)\n</catalog>",
  );
  blocks.push("Extract the price list from the content above.");
  content.push({ type: "text", text: blocks.join("\n\n"), fakeKeyText: untrustedKey(message) });
  return { ok: true, content };
}
