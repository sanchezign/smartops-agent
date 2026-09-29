import type { Messages } from "next-intl";
import type { InputError } from "@/lib/number-input";

/**
 * The no-code rules of the panel (phase 9 M6): which settings are shown, grouped, with the
 * same limits the API validates (apps/api/src/modules/settings/settings.schemas.ts). The API
 * re-validates every value; these only give early, plain-language feedback.
 *
 * Texts (phase 13) live in the "rules" messages: section titles by `id`, field label / help /
 * suffix by `fieldMessageKey(field.key)` ("bot.autoRepliesEnabled" → "bot_autoRepliesEnabled",
 * because next-intl reads dots as nesting). A unit test checks every field has its messages.
 */

export type Field =
  | { key: string; kind: "switch" }
  | {
      key: string;
      kind: "number";
      /** The catalog has a "suffix" (unit) for this field. */
      suffix?: true;
      min?: number;
      max?: number;
      integer?: boolean;
      /** Empty input = null (e.g. low stock alert off). */
      nullable?: boolean;
    }
  | { key: string; kind: "keywords" }
  | { key: string; kind: "phones" }
  | { key: "businessHours"; kind: "hours" }
  | { key: "business.language"; kind: "language" };

export type SectionId = keyof Messages["rules"]["sections"];
export type FieldMessageKey = keyof Messages["rules"]["fields"];

export interface Section {
  id: SectionId;
  fields: Field[];
}

export function fieldMessageKey(key: string): FieldMessageKey {
  return key.replaceAll(".", "_") as FieldMessageKey;
}

export const SECTIONS: Section[] = [
  {
    id: "bot",
    fields: [
      { key: "business.language", kind: "language" },
      { key: "bot.autoRepliesEnabled", kind: "switch" },
      { key: "bot.supplierAck", kind: "switch" },
      {
        key: "coexistence.humanTakeoverMinutes",
        kind: "number",
        suffix: true,
        min: 1,
        max: 10080,
        integer: true,
      },
    ],
  },
  { id: "hours", fields: [{ key: "businessHours", kind: "hours" }] },
  {
    id: "prices",
    fields: [
      { key: "catalog.priceAlertPct", kind: "number", suffix: true, min: 0, max: 100000 },
      { key: "catalog.maxIncreasePct", kind: "number", suffix: true, min: 0.01, max: 100000 },
      { key: "catalog.maxDecreasePct", kind: "number", suffix: true, min: 0.01, max: 100 },
      {
        key: "catalog.lowStockThreshold",
        kind: "number",
        suffix: true,
        min: 0,
        integer: true,
        nullable: true,
      },
      { key: "catalog.autoCreateProducts", kind: "switch" },
      { key: "catalog.reactivateOnQuote", kind: "switch" },
    ],
  },
  {
    id: "team",
    fields: [
      { key: "notifications.whatsappRecipients", kind: "phones" },
      {
        key: "notifications.digestWindowMinutes",
        kind: "number",
        suffix: true,
        min: 1,
        max: 240,
        integer: true,
      },
      {
        key: "notifications.maxPerHour",
        kind: "number",
        suffix: true,
        min: 1,
        max: 60,
        integer: true,
      },
      {
        key: "notifications.criticalMaxPerHour",
        kind: "number",
        suffix: true,
        min: 0,
        max: 20,
        integer: true,
      },
    ],
  },
  {
    id: "contacts",
    fields: [
      {
        key: "transcription.maxAutoDurationSeconds",
        kind: "number",
        suffix: true,
        min: 10,
        max: 3600,
        integer: true,
      },
      { key: "optOut.keywords", kind: "keywords" },
      { key: "optIn.keywords", kind: "keywords" },
      {
        key: "optOut.instructionReminderDays",
        kind: "number",
        suffix: true,
        min: 1,
        max: 365,
        integer: true,
      },
    ],
  },
];

type ListParse = { ok: true; value: string[] } | { ok: false; error: InputError };

/** "baja, Stop ,, cancelar" → ["BAJA", "STOP", "CANCELAR"] (1–20 words of ≤ 40 chars). */
export function parseKeywords(raw: string): ListParse {
  const words = [
    ...new Set(
      raw
        .split(",")
        .map((w) => w.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (words.length === 0) return { ok: false, error: { code: "keywordsEmpty" } };
  if (words.length > 20) return { ok: false, error: { code: "keywordsTooMany" } };
  if (words.some((w) => w.length > 40)) return { ok: false, error: { code: "keywordTooLong" } };
  return { ok: true, value: words };
}

/** One number per line or comma; digits only (8–15), up to 10. */
export function parsePhones(raw: string): ListParse {
  const numbers = [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((n) => n.replace(/[\s+\-()]/g, ""))
        .filter(Boolean),
    ),
  ];
  const bad = numbers.find((n) => !/^\d{8,15}$/.test(n));
  if (bad) return { ok: false, error: { code: "phoneInvalid", params: { value: bad } } };
  if (numbers.length > 10) return { ok: false, error: { code: "phonesTooMany" } };
  return { ok: true, value: numbers };
}
