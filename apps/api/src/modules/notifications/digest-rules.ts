/**
 * Notification rules (pure, phase 6). Anti-spam (user rule): only ACTIONABLE events are
 * notified; a run without news stays in the panel. WhatsApp recipients get ONE message per
 * digest window, capped per hour; critical errors skip the window with their own cap.
 * Texts follow the business language (phase 13, common/business-texts.ts; Spanish by default).
 */

import {
  businessMoney,
  businessPct,
  businessTexts,
  type BusinessLanguage,
} from "../../common/business-texts.js";

export interface RunFacts {
  runId: string;
  supplierName: string | null;
  increases: number;
  increasesOverThreshold: number;
  thresholdPct: number;
  lowStock: number;
  pendingReviews: number;
  /** The biggest price change of the run (phase 9 M7); absent in digests recorded before. */
  mainChange?: {
    productName: string;
    oldPrice: string;
    newPrice: string;
    currency: string;
    changePct: string;
  } | null;
}

export function isActionableRun(facts: RunFacts): boolean {
  return facts.increasesOverThreshold > 0 || facts.lowStock > 0 || facts.pendingReviews > 0;
}

export type ItemData =
  | ({ category: "run_summary" } & RunFacts)
  | { category: "customer_query"; messageId: string; contactName: string | null; preview: string }
  | { category: "order"; messageId: string; contactName: string | null; preview: string }
  | { category: "integration_error"; source: string; message: string }
  | {
      category: "manual_attention";
      /** Technical fallback (items recorded before phase 13 have only this). */
      title: string;
      /** Structured (phase 13): the digest composes the line in the business language. */
      reason?: string;
      durationSeconds?: number | null;
      sizeBytes?: number | null;
      maxSeconds?: number | null;
    };

/** "10 %" (es) / "10%" (en): a threshold, without sign. */
const threshold = (language: BusinessLanguage, pct: number) =>
  businessPct(language, pct).replace(/^[+−]/, "");

export function runTitle(facts: RunFacts, language: BusinessLanguage = "es"): string {
  const { digest } = businessTexts(language);
  const parts: string[] = [];
  if (facts.increases > 0) {
    parts.push(
      facts.increasesOverThreshold > 0
        ? `${digest.increases(facts.increases)} (${digest.overThreshold(facts.increasesOverThreshold, threshold(language, facts.thresholdPct))})`
        : digest.increases(facts.increases),
    );
  }
  if (facts.lowStock > 0) parts.push(digest.lowStock(facts.lowStock));
  if (facts.pendingReviews > 0) parts.push(digest.pendingReviews(facts.pendingReviews));
  return `${facts.supplierName ?? digest.processedList}: ${parts.join(", ")}`;
}

/** Max detail lines in one digest; the rest is "+N more in the panel" (user rule: few lines). */
export const DIGEST_MAX_LINES = 5;
const SNIPPET_CHARS = 60;
const NAME_CHARS = 40;
const DIGEST_MAX_CHARS = 1024;

/**
 * Text written by a contact (or a supplier name) → safe to quote to the team: control chars
 * and line breaks removed, links replaced (never a clickable URL from a stranger), WhatsApp
 * formatting marks (* _ ~ `) and our quote marks stripped, truncated with "…".
 */
export function neutralize(
  text: string | null | undefined,
  max: number,
  language: BusinessLanguage = "es",
): string {
  const clean = (text ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, businessTexts(language).digest.link)
    .replace(/[*_~`«»“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

type Line = { priority: number; text: string };

function runLine(
  run: Extract<ItemData, { category: "run_summary" }>,
  language: BusinessLanguage,
): string {
  const { digest } = businessTexts(language);
  const supplier = neutralize(run.supplierName ?? digest.processedList, NAME_CHARS, language);
  const parts: string[] = [];
  const main = run.mainChange;
  if (main) {
    parts.push(
      `${neutralize(main.productName, NAME_CHARS, language)} ${businessMoney(language, main.oldPrice, main.currency)} → ${businessMoney(language, main.newPrice, main.currency)} (${businessPct(language, main.changePct)})`,
    );
    const others = run.increases - (Number(main.changePct) > 0 ? 1 : 0);
    if (others > 0) parts.push(digest.moreIncreases(others));
  } else if (run.increases > 0) {
    parts.push(digest.increases(run.increases));
  }
  if (run.lowStock > 0) parts.push(digest.lowStock(run.lowStock));
  if (run.pendingReviews > 0) parts.push(digest.pendingReviews(run.pendingReviews));
  return `${supplier}: ${parts.join(", ")}`;
}

/** "4:12" from seconds, or "3.2 MB" when the duration could not be read. */
function audioLength(
  i: Extract<ItemData, { category: "manual_attention" }>,
  language: BusinessLanguage,
): string | null {
  if (typeof i.durationSeconds === "number") {
    const s = Math.round(i.durationSeconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  if (typeof i.sizeBytes === "number") {
    const mb = new Intl.NumberFormat(businessTexts(language).intlLocale, {
      maximumFractionDigits: 1,
    }).format(i.sizeBytes / 1024 / 1024);
    return `${mb} MB`;
  }
  return null;
}

function manualLine(
  i: Extract<ItemData, { category: "manual_attention" }>,
  language: BusinessLanguage,
): string {
  if (i.reason === "audio_too_long") {
    const limit = typeof i.maxSeconds === "number" ? Math.round(i.maxSeconds / 60) : null;
    return businessTexts(language).digest.audioTooLong(audioLength(i, language), limit);
  }
  return neutralize(i.title, 90, language);
}

function detailLines(items: ItemData[], language: BusinessLanguage): Line[] {
  const { digest } = businessTexts(language);
  const name = (n: string | null) => neutralize(n ?? digest.aContact, NAME_CHARS, language);
  return items.map((i): Line => {
    switch (i.category) {
      case "integration_error":
        return {
          priority: 0,
          text: digest.error(
            neutralize(i.source, NAME_CHARS, language),
            neutralize(i.message, 80, language),
          ),
        };
      case "order":
        return {
          priority: 1,
          text: digest.order(name(i.contactName), neutralize(i.preview, SNIPPET_CHARS, language)),
        };
      case "customer_query":
        return {
          priority: 2,
          text: digest.query(name(i.contactName), neutralize(i.preview, SNIPPET_CHARS, language)),
        };
      case "run_summary":
        return { priority: 3, text: runLine(i, language) };
      case "manual_attention":
        return { priority: 4, text: `🎧 ${manualLine(i, language)}` };
    }
  });
}

function headline(items: ItemData[], language: BusinessLanguage): string {
  const { headline: h } = businessTexts(language).digest;
  const count = (category: ItemData["category"]) =>
    items.filter((i) => i.category === category).length;
  const parts = [
    count("integration_error") > 0 ? h.errors(count("integration_error")) : null,
    count("order") > 0 ? h.orders(count("order")) : null,
    count("customer_query") > 0 ? h.queries(count("customer_query")) : null,
    count("run_summary") > 0 ? h.lists(count("run_summary")) : null,
    count("manual_attention") > 0 ? h.audios(count("manual_attention")) : null,
  ].filter(Boolean);
  return `SmartOps · ${parts.join(" · ")}`;
}

/**
 * One WhatsApp text per digest (phase 9 M7, user: a little context per item, still ONE
 * message): a headline with counts, up to DIGEST_MAX_LINES detail lines (errors, orders,
 * queries, lists, audios — in that order) with neutralized snippets, "+N more" and the panel
 * link (/d/<random token>: no content in the URL, login required).
 *
 * singleLine: for a template body parameter (WhatsApp does not allow line breaks there).
 */
export function renderDigest(
  items: ItemData[],
  options: { link?: string | null; singleLine?: boolean; language?: BusinessLanguage } = {},
): string {
  const language = options.language ?? "es";
  const { digest } = businessTexts(language);
  const details = detailLines(items, language).sort((a, b) => a.priority - b.priority);
  const shown = details.slice(0, DIGEST_MAX_LINES).map((l) => l.text);
  const rest = details.length - shown.length;
  const footer = options.link ? digest.viewInPanel(options.link) : digest.detailsInPanel;
  const build = (lines: string[], extra: number) => {
    const body = [...lines, ...(extra > 0 ? [digest.more(extra)] : [])];
    return options.singleLine
      ? [headline(items, language), ...body, footer].join(" · ")
      : [headline(items, language), ...body.map((l) => `• ${l}`), footer].join("\n");
  };
  // Keep within the limit by dropping detail lines (never cutting the link in half).
  let count = shown.length;
  let text = build(shown, rest);
  while (text.length > DIGEST_MAX_CHARS && count > 0) {
    count -= 1;
    text = build(shown.slice(0, count), details.length - count);
  }
  return text.length > DIGEST_MAX_CHARS
    ? `${headline(items, language)} · ${footer}`.slice(0, DIGEST_MAX_CHARS)
    : text;
}

/**
 * Hourly cap: when `sentAt` (sends of the last hour, any order) already reached the cap,
 * the digest waits until the oldest of them leaves the window. Null = can send now.
 */
export function nextAllowedSend(sentAt: Date[], cap: number, now: Date): Date | null {
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const recent = sentAt
    .filter((d) => d.getTime() > hourAgo)
    .sort((a, b) => a.getTime() - b.getTime());
  if (recent.length < cap) return null;
  return new Date(recent[recent.length - cap]!.getTime() + 60 * 60 * 1000);
}
