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

import type { BusinessLanguage } from "../../common/business-texts.js";

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

/**
 * The words of each LANGUAGE (phase 14 M5b, ADR-031). `business.language` picks ONE table: the
 * patterns of the other language are NOT mixed in. With "es" these are the very patterns the
 * pre-filter always had (test/unit/heuristics-es-identical.test.ts compares them with a frozen
 * copy of the old code); "en" has its own.
 */
interface Patterns {
  /** Numbers, currency, price / stock words. */
  price: RegExp;
  /** Order / purchase request words. */
  order: RegExp;
  /**
   * A question or a request about products: it may be an order or a query. A bare "?" is NOT
   * enough ("buen día, cómo andás?" stays chit-chat, without LLM).
   */
  request: RegExp;
}

const PATTERNS: Record<BusinessLanguage, Patterns> = {
  es: {
    price:
      /\d|\$|u\$s|us\$|\busd\b|\buyu\b|\bars\b|pesos?\b|d[oó]lar|precio|lista|sub[eií]|suben|baj[aó]|bajan|aument|rebaj|descuento|oferta|promo|stock|no hay|agotad|disponib|costo|valor|cotiz|iva/i,
    /** Order / purchase request words (Rioplatense and neutral Spanish, accents removed). */
    order:
      /\b(necesit\w*|quiero|querria|quisiera|manda\w*|envia\w*|pedi\w*|pedido|encarg\w*|reserv\w*|compr\w*|llevo|me (llevo|das|pasas))\b/i,
    request: /\b(tienen|tenes|hay|cuanto|cuando|donde|entrega|envio|consulta)\b/i,
  },
  en: {
    // A digit or "$" is enough for most lists; words cover the rest ("price list attached", "bolts
    // are going up", "out of stock"). "up" / "down" alone are NOT signals ("what's up").
    price:
      /\d|\$|\busd\b|\bcad\b|\bdollars?\b|\bprices?\b|\bpricing\b|\blist\b|\bincrease[ds]?\b|\braise[ds]?\b|\braising\b|\bhikes?\b|\bgo(?:es|ing)? (?:up|down)\b|\bmark(?:ed|ing)? (?:up|down)\b|\bdiscounts?\b|\bmarkdowns?\b|\bsale\b|\bpromo(?:tion)?s?\b|\bstock\b|\bsold out\b|\bavailab\w*|\bunavailable\b|\bdiscontinued\b|\bback ?order\w*|\bcosts?\b|\bquote[ds]?\b|\btax\b/i,
    order:
      /\b(?:need(?:s|ed)?|want(?:s|ed)?|would like|i[’']d like|order(?:s|ed|ing)?|send(?: me)?|reserve[ds]?|hold|buy|purchase|pick ?up|get me|can i (?:get|have)|i[’']ll take|ship)\b/i,
    request:
      /\b(?:do you (?:have|carry|stock|sell)|have you got|is there|are there|how (?:much|many)|how long|when|where|delivery|deliver|shipping|inquiry)\b/i,
  },
};

const REASONS: Record<
  BusinessLanguage,
  {
    customerOrder: string;
    customerQuery: string;
    nonContent(messageType: string): string;
    mediaUnavailable(status: string): string;
    audioTooLong: string;
    audioNotTranscribed(why: string): string;
    audioNoSignal: string;
    textNoSignal: string;
    unknown: string;
  }
> = {
  es: {
    customerOrder: "Contacto cliente con palabras de pedido: pedido para el equipo (sin LLM).",
    customerQuery: "Contacto cliente: nunca pasa a extracción de precios (sin LLM).",
    nonContent: (messageType) =>
      `Mensaje de tipo ${messageType}: no puede ser una lista de precios.`,
    mediaUnavailable: (status) => `Archivo no disponible (${status}).`,
    audioTooLong: "Audio largo sin transcribir: escuchar a mano.",
    audioNotTranscribed: (why) => `Audio sin transcripción (${why}).`,
    audioNoSignal: "Audio sin números, moneda ni palabras de precio o stock.",
    textNoSignal: "Texto sin números, moneda ni palabras de precio o stock.",
    unknown: "desconocido",
  },
  en: {
    customerOrder: "Customer contact with order words: an order for the team (no LLM).",
    customerQuery: "Customer contact: never goes to price extraction (no LLM).",
    nonContent: (messageType) => `Message of type ${messageType}: it cannot be a price list.`,
    mediaUnavailable: (status) => `File not available (${status}).`,
    audioTooLong: "Long voice note, not transcribed: listen to it by hand.",
    audioNotTranscribed: (why) => `Voice note without a transcript (${why}).`,
    audioNoSignal: "Voice note without numbers, currency, or price or stock words.",
    textNoSignal: "Text without numbers, currency, or price or stock words.",
    unknown: "unknown",
  },
};

export function hasPriceSignal(text: string, language: BusinessLanguage = "es"): boolean {
  return PATTERNS[language].price.test(text);
}

/** Accents removed, so the patterns above only need plain letters ("mandá" → "manda"). */
function normalizeAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function hasOrderSignal(text: string, language: BusinessLanguage = "es"): boolean {
  return PATTERNS[language].order.test(normalizeAccents(text));
}

export function hasRequestSignal(text: string, language: BusinessLanguage = "es"): boolean {
  return hasOrderSignal(text, language) || PATTERNS[language].request.test(normalizeAccents(text));
}

export function prefilter(
  input: PrefilterInput,
  language: BusinessLanguage = "es",
): PrefilterDecision | null {
  const reasons = REASONS[language];
  if (input.contactKind === "customer") {
    const text = input.text ?? input.transcript ?? "";
    return hasOrderSignal(text, language)
      ? {
          rule: "customer_contact",
          classification: "internal_order",
          reason: reasons.customerOrder,
        }
      : {
          rule: "customer_contact",
          classification: "customer_query",
          reason: reasons.customerQuery,
        };
  }
  if (NON_CONTENT_TYPES.has(input.messageType)) {
    return {
      rule: "non_content_type",
      classification: "other",
      reason: reasons.nonContent(input.messageType),
    };
  }
  if (input.mediaStatus !== null && input.mediaStatus !== "stored") {
    return {
      rule: "media_unavailable",
      classification: "other",
      reason: reasons.mediaUnavailable(input.mediaStatus),
    };
  }
  if (input.messageType === "audio") {
    if (input.transcriptionReason === "too_long") {
      return {
        rule: "audio_too_long",
        classification: "other",
        reason: reasons.audioTooLong,
      };
    }
    if (!input.transcript) {
      return {
        rule: "audio_not_transcribed",
        classification: "other",
        reason: reasons.audioNotTranscribed(
          input.transcriptionReason ?? input.transcriptionStatus ?? reasons.unknown,
        ),
      };
    }
    return hasPriceSignal(input.transcript, language) ||
      hasRequestSignal(input.transcript, language)
      ? null
      : {
          rule: "no_price_signal",
          classification: "other",
          reason: reasons.audioNoSignal,
        };
  }
  if (input.messageType === "text") {
    return hasPriceSignal(input.text ?? "", language) ||
      hasRequestSignal(input.text ?? "", language)
      ? null
      : {
          rule: "no_price_signal",
          classification: "other",
          reason: reasons.textNoSignal,
        };
  }
  // image / document (PDF, photo, spreadsheet…): the extraction decides.
  return null;
}
