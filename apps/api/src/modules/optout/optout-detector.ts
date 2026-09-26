/**
 * Deterministic opt-in / opt-out detection (phase 7, ADR-017) — NO LLM, so it is
 * predictable, auditable and $0. Rules deliberately conservative: only the WHOLE message
 * (after stripping "por favor" / "gracias") equal to a keyword, or one of a small fixed
 * set of explicit phrases in a SHORT message, is treated as opt-in/opt-out. "baja el
 * cemento 10%" must never match; "BAJA" or "Stop!!!" must.
 */

export type ComplianceEventKind = "opt_out" | "opt_in" | "possible_opt_out";

export interface ComplianceDetection {
  kind: ComplianceEventKind;
  /** The keyword or phrase pattern that matched (for the audit log). */
  matched: string;
}

/** Optional words allowed around a keyword ("por favor BAJA", "Stop, gracias"). */
const FILLER_TOKENS = new Set(["por", "favor", "gracias"]);

/** Phrase matches only apply to messages this short (in words) — never a price list. */
const MAX_PHRASE_WORDS = 12;

/** Explicit opt-out requests beyond a bare keyword (case/accent-insensitive, fixed set). */
const HARD_OPT_OUT_PHRASES: readonly RegExp[] = [
  /\bno me escriban? mas\b/,
  /\bno me manden? mas mensajes\b/,
  /\bno quiero recibir mas mensajes\b/,
  /\bdejen de escribirme\b/,
  /\bquiero darme de baja\b/,
  /\bdeseo darme de baja\b/,
  /\b(saquenme|borrenme) de la lista\b/,
];

/** Ambiguous: likely means "stop contacting me", but not certain enough to auto-apply. */
const SOFT_POSSIBLE_OPT_OUT_PHRASES: readonly RegExp[] = [
  /\bya no trabajo con ustedes\b/,
  /\bya no necesito mas\b/,
  /\bno me interesa mas\b/,
  /\bdejen de mandarme\b/,
];

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation, emoji, symbols
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && FILLER_TOKENS.has(tokens[start] as string)) start += 1;
  while (end > start && FILLER_TOKENS.has(tokens[end - 1] as string)) end -= 1;
  return tokens.slice(start, end);
}

/**
 * Detects an opt-out / opt-in / ambiguous ("possible_opt_out") message. `null` for
 * anything else (including a price list that happens to contain the word "baja").
 */
export function detectComplianceEvent(
  text: string,
  keywords: { optOut: readonly string[]; optIn: readonly string[] },
): ComplianceDetection | null {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;

  const tokens = stripFiller(normalized.split(" "));
  if (tokens.length === 1) {
    const word = tokens[0] as string;
    if (keywords.optOut.some((k) => normalizeForMatch(k) === word))
      return { kind: "opt_out", matched: word };
    if (keywords.optIn.some((k) => normalizeForMatch(k) === word))
      return { kind: "opt_in", matched: word };
  }

  if (normalized.split(" ").length <= MAX_PHRASE_WORDS) {
    for (const re of HARD_OPT_OUT_PHRASES) {
      const match = re.exec(normalized);
      if (match) return { kind: "opt_out", matched: match[0] };
    }
    for (const re of SOFT_POSSIBLE_OPT_OUT_PHRASES) {
      const match = re.exec(normalized);
      if (match) return { kind: "possible_opt_out", matched: match[0] };
    }
  }

  return null;
}

/** Appended to an auto reply per the opt-out policy (business must give clear instructions). */
export const OPT_OUT_INSTRUCTION_TEXT =
  "Respondé BAJA si no querés recibir más mensajes automáticos.";

/** The one compliance reply allowed for an opted-out contact (ADR-017). */
export const OPT_OUT_CONFIRMATION_TEXT =
  "Listo, no vas a recibir más mensajes automáticos nuestros. Para volver a recibirlos, respondé ALTA.";

export const OPT_IN_CONFIRMATION_TEXT =
  "Listo, vas a volver a recibir nuestros mensajes automáticos.";
