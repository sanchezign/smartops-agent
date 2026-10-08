/* FROZEN COPY of apps/api/src/modules/extraction/prefilter.ts as of commit c4d2f42 (phase 14 M5b, BEFORE the heuristics got a language).
 * It is the reference of what the Spanish behavior WAS: test/unit/heuristics-es-identical.test.ts compares
 * today's code, with the language set to "es", against it. Never edit it. */
/**
 * Deterministic pre-filter BEFORE the classifier (pure, phase 6 M1). It lives inside
 * classify() so no caller (n8n, the panel, the demo) can skip it: obvious messages never
 * reach Claude, and every decision is recorded in ingestion_runs.prefilter_rule so the
 * dashboard can show how many LLM calls were saved.
 *
 * Only what can be a price list goes on: numbers, currency, price/stock words, or a PDF,
 * image, spreadsheet or voice note from a supplier (or a still unknown contact).
 *
 * Phase 8 (user rule): an ORDER or a question must never be dropped. A request signal
 * ("necesito", "¿tienen…?", "mandame"…) sends the text to the classifier even without
 * numbers; a customer's message with an order signal is labeled internal_order (no LLM).
 */

export type PrefilterRule =
  | "customer_contact"
  | "non_content_type"
  | "media_unavailable"
  | "audio_too_long"
  | "audio_not_transcribed"
  | "no_price_signal";

export interface PrefilterDecision {
  rule: PrefilterRule;
  classification: "other" | "customer_query" | "internal_order";
  reason: string;
}

export interface PrefilterInput {
  messageType: string;
  contactKind: string;
  text: string | null;
  transcript: string | null;
  /** Null when the message has no media. */
  mediaStatus: string | null;
  transcriptionStatus: string | null;
  transcriptionReason: string | null;
}

/** Message types that never carry a price list. */
const NON_CONTENT_TYPES = new Set([
  "sticker",
  "reaction",
  "location",
  "contacts",
  "interactive",
  "button",
  "template",
  "unsupported",
  "video",
]);

const PRICE_SIGNAL =
  /\d|\$|u\$s|us\$|\busd\b|\buyu\b|\bars\b|pesos?\b|d[oó]lar|precio|lista|sub[eií]|suben|baj[aó]|bajan|aument|rebaj|descuento|oferta|promo|stock|no hay|agotad|disponib|costo|valor|cotiz|iva/i;

export function hasPriceSignal(text: string): boolean {
  return PRICE_SIGNAL.test(text);
}

/** Order / purchase request words (Rioplatense and neutral Spanish, accents removed). */
const ORDER_SIGNAL =
  /\b(necesit\w*|quiero|querria|quisiera|manda\w*|envia\w*|pedi\w*|pedido|encarg\w*|reserv\w*|compr\w*|llevo|me (llevo|das|pasas))\b/i;

/**
 * A question or a request about products: it may be an order or a query. A bare "?" is NOT
 * enough ("buen día, cómo andás?" stays chit-chat, without LLM).
 */
const REQUEST_SIGNAL = /\b(tienen|tenes|hay|cuanto|cuando|donde|entrega|envio|consulta)\b/i;

/** Accents removed, so the patterns above only need plain letters ("mandá" → "manda"). */
function normalizeAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function hasOrderSignal(text: string): boolean {
  return ORDER_SIGNAL.test(normalizeAccents(text));
}

export function hasRequestSignal(text: string): boolean {
  return hasOrderSignal(text) || REQUEST_SIGNAL.test(normalizeAccents(text));
}

export function prefilter(input: PrefilterInput): PrefilterDecision | null {
  if (input.contactKind === "customer") {
    const text = input.text ?? input.transcript ?? "";
    return hasOrderSignal(text)
      ? {
          rule: "customer_contact",
          classification: "internal_order",
          reason: "Contacto cliente con palabras de pedido: pedido para el equipo (sin LLM).",
        }
      : {
          rule: "customer_contact",
          classification: "customer_query",
          reason: "Contacto cliente: nunca pasa a extracción de precios (sin LLM).",
        };
  }
  if (NON_CONTENT_TYPES.has(input.messageType)) {
    return {
      rule: "non_content_type",
      classification: "other",
      reason: `Mensaje de tipo ${input.messageType}: no puede ser una lista de precios.`,
    };
  }
  if (input.mediaStatus !== null && input.mediaStatus !== "stored") {
    return {
      rule: "media_unavailable",
      classification: "other",
      reason: `Archivo no disponible (${input.mediaStatus}).`,
    };
  }
  if (input.messageType === "audio") {
    if (input.transcriptionReason === "too_long") {
      return {
        rule: "audio_too_long",
        classification: "other",
        reason: "Audio largo sin transcribir: escuchar a mano.",
      };
    }
    if (!input.transcript) {
      return {
        rule: "audio_not_transcribed",
        classification: "other",
        reason: `Audio sin transcripción (${input.transcriptionReason ?? input.transcriptionStatus ?? "desconocido"}).`,
      };
    }
    return hasPriceSignal(input.transcript) || hasRequestSignal(input.transcript)
      ? null
      : {
          rule: "no_price_signal",
          classification: "other",
          reason: "Audio sin números, moneda ni palabras de precio o stock.",
        };
  }
  if (input.messageType === "text") {
    return hasPriceSignal(input.text ?? "") || hasRequestSignal(input.text ?? "")
      ? null
      : {
          rule: "no_price_signal",
          classification: "other",
          reason: "Texto sin números, moneda ni palabras de precio o stock.",
        };
  }
  // image / document (PDF, photo, spreadsheet…): the extraction decides.
  return null;
}
