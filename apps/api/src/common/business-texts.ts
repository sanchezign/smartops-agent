/**
 * Texts the backend SENDS over WhatsApp (phase 13): opt-out / opt-in replies, the opt-out
 * instruction, the supplier acknowledgement and the team digest. They follow the business
 * language (Setting `business.language`, Spanish by default) — never the panel language of
 * whoever is logged in. Spanish uses "usted" with contacts (user rule, 2026-09-28).
 *
 * The keywords named here must be accepted by the default opt-out / opt-in keyword settings
 * (BAJA / ALTA and STOP / START are both in the defaults — test/unit/business-texts.test.ts).
 */

export const BUSINESS_LANGUAGES = ["es", "en"] as const;
export type BusinessLanguage = (typeof BUSINESS_LANGUAGES)[number];

export function toBusinessLanguage(value: unknown): BusinessLanguage {
  return value === "en" ? "en" : "es";
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface BusinessTexts {
  optOutKeyword: string;
  optInKeyword: string;
  optOutInstruction: string;
  optOutConfirmation: string;
  optInConfirmation: string;
  ack: {
    underReview: string;
    listWith(parts: string[]): string;
    listNoChanges: string;
    pricesUpdated(n: number): string;
    newProducts(n: number): string;
    pendingReview(n: number): string;
    thanks(text: string): string;
  };
  digest: {
    processedList: string;
    aContact: string;
    link: string;
    increases(n: number): string;
    moreIncreases(n: number): string;
    overThreshold(n: number, pct: string): string;
    lowStock(n: number): string;
    pendingReviews(n: number): string;
    order(name: string, snippet: string): string;
    query(name: string, snippet: string): string;
    error(source: string, message: string): string;
    audioTooLong(length: string | null, limitMinutes: number | null): string;
    headline: {
      errors(n: number): string;
      orders(n: number): string;
      queries(n: number): string;
      lists(n: number): string;
      audios(n: number): string;
    };
    more(n: number): string;
    viewInPanel(link: string): string;
    detailsInPanel: string;
  };
  /** Number formatting of the language (money with the business-currency "$" rule). */
  intlLocale: string;
}

const ES: BusinessTexts = {
  optOutKeyword: "BAJA",
  optInKeyword: "ALTA",
  optOutInstruction: "Responda BAJA si no desea recibir más mensajes automáticos.",
  optOutConfirmation:
    "Listo, no recibirá más mensajes automáticos nuestros. Para volver a recibirlos, responda ALTA.",
  optInConfirmation: "Listo, volverá a recibir nuestros mensajes automáticos.",
  ack: {
    underReview: "¡Gracias! Recibimos su mensaje; nuestro equipo lo revisa y le confirmamos.",
    listWith: (parts) => `Recibimos su lista: ${parts.join(", ")}.`,
    listNoChanges: "Recibimos su lista; no hubo cambios de precio.",
    pricesUpdated: (n) => count(n, "precio actualizado", "precios actualizados"),
    newProducts: (n) => count(n, "producto nuevo", "productos nuevos"),
    pendingReview: (n) =>
      n === 1
        ? "Un punto queda para revisión de nuestro equipo."
        : `${n} puntos quedan para revisión de nuestro equipo.`,
    thanks: (text) => `¡Gracias! ${text}`,
  },
  digest: {
    processedList: "Lista procesada",
    aContact: "un contacto",
    link: "[enlace]",
    increases: (n) => count(n, "aumento", "aumentos"),
    moreIncreases: (n) => count(n, "aumento más", "aumentos más"),
    overThreshold: (n, pct) => `${n} ${n === 1 ? "mayor" : "mayores"} al ${pct}`,
    lowStock: (n) => count(n, "producto con stock bajo", "productos con stock bajo"),
    pendingReviews: (n) => count(n, "revisión pendiente", "revisiones pendientes"),
    order: (name, snippet) => `Pedido de ${name}: «${snippet}»`,
    query: (name, snippet) => `Consulta de ${name}: «${snippet}»`,
    error: (source, message) => `⚠️ Error (${source}): ${message}`,
    audioTooLong: (length, limit) =>
      `Audio${length ? ` de ${length}` : ""} sin transcribir${limit ? ` (límite ${limit} min)` : ""}: escuchar manualmente`,
    headline: {
      errors: (n) => `⚠️ ${count(n, "error", "errores")}`,
      orders: (n) => count(n, "pedido", "pedidos"),
      queries: (n) => count(n, "consulta", "consultas"),
      lists: (n) => count(n, "lista", "listas"),
      audios: (n) => count(n, "audio para escuchar", "audios para escuchar"),
    },
    more: (n) => `+${n} más en el panel`,
    viewInPanel: (link) => `Ver en el panel: ${link}`,
    detailsInPanel: "Detalle en el panel.",
  },
  intlLocale: "es-UY",
};

const EN: BusinessTexts = {
  optOutKeyword: "STOP",
  optInKeyword: "START",
  optOutInstruction: "Reply STOP if you don't want to receive more automatic messages.",
  optOutConfirmation:
    "Done: you won't receive more automatic messages from us. To receive them again, reply START.",
  optInConfirmation: "Done: you'll receive our automatic messages again.",
  ack: {
    underReview: "Thank you! We received your message; our team will review it and confirm.",
    listWith: (parts) => `We received your list: ${parts.join(", ")}.`,
    listNoChanges: "We received your list; there were no price changes.",
    pricesUpdated: (n) => count(n, "price updated", "prices updated"),
    newProducts: (n) => count(n, "new product", "new products"),
    pendingReview: (n) =>
      n === 1
        ? "One item is pending review by our team."
        : `${n} items are pending review by our team.`,
    thanks: (text) => `Thank you! ${text}`,
  },
  digest: {
    processedList: "List processed",
    aContact: "a contact",
    link: "[link]",
    increases: (n) => count(n, "increase", "increases"),
    moreIncreases: (n) => count(n, "more increase", "more increases"),
    overThreshold: (n, pct) => `${n} above ${pct}`,
    lowStock: (n) => count(n, "product low on stock", "products low on stock"),
    pendingReviews: (n) => count(n, "pending review", "pending reviews"),
    order: (name, snippet) => `Order from ${name}: “${snippet}”`,
    query: (name, snippet) => `Question from ${name}: “${snippet}”`,
    error: (source, message) => `⚠️ Error (${source}): ${message}`,
    audioTooLong: (length, limit) =>
      `Voice note${length ? ` (${length})` : ""} not transcribed${limit ? ` (limit ${limit} min)` : ""}: listen by hand`,
    headline: {
      errors: (n) => `⚠️ ${count(n, "error", "errors")}`,
      orders: (n) => count(n, "order", "orders"),
      queries: (n) => count(n, "question", "questions"),
      lists: (n) => count(n, "list", "lists"),
      audios: (n) => count(n, "voice note to listen to", "voice notes to listen to"),
    },
    more: (n) => `+${n} more in the panel`,
    viewInPanel: (link) => `View in the panel: ${link}`,
    detailsInPanel: "Details in the panel.",
  },
  intlLocale: "en-US",
};

export function businessTexts(language: BusinessLanguage): BusinessTexts {
  return language === "en" ? EN : ES;
}

/**
 * Money for a WhatsApp text: "$" is the business currency (UYU), USD "US$", other currencies
 * their code — the same rule as the panel, so two currencies never share "$".
 */
export function businessMoney(language: BusinessLanguage, value: string, currency: string): string {
  const locale = businessTexts(language).intlLocale;
  try {
    const symbol =
      new Intl.NumberFormat("es-UY", { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currency;
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value as unknown as number);
    if (/^[A-Z]{3}$/.test(symbol)) return `${currency} ${number}`;
    return language === "es" ? `${symbol} ${number}` : `${symbol}${number}`;
  } catch {
    return `${value} ${currency}`;
  }
}

/** Signed percentage, up to one decimal: "+16,7 %" (es) / "+16.7%" (en). */
export function businessPct(language: BusinessLanguage, value: string | number): string {
  const n = Number(value);
  const text = new Intl.NumberFormat(businessTexts(language).intlLocale, {
    maximumFractionDigits: 1,
  }).format(Math.abs(n));
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return language === "es" ? `${sign}${text} %` : `${sign}${text}%`;
}
