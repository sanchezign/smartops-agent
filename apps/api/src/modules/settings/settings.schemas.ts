import { z } from "zod";

/**
 * No-code rules (Setting table: key → JSON value). Defaults live in code; a row in the DB
 * overrides its key. Every key is validated with Zod here — the panel (phase 9) writes
 * through the same schemas. An invalid stored value falls back to the default (and is
 * reported), so a bad edit can never break ingestion.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");

/** Opening hours per weekday (business-hours.ts evaluates them). */
export const businessHoursSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: "unknown time zone" },
      ),
    days: z
      .array(
        z
          .object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm })
          .refine((d) => d.open !== d.close, { message: "open and close must differ" }),
      )
      .max(14),
  })
  .strict();
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const SETTING_DEFINITIONS = {
  /** Price increases above this % go to human review instead of being applied. */
  "catalog.maxIncreasePct": { schema: z.number().positive().max(100_000), default: 50 },
  /** Price decreases above this % (absolute) go to human review. */
  "catalog.maxDecreasePct": { schema: z.number().positive().max(100), default: 30 },
  /** Applied price changes at or above this % (absolute) create a price_change Alert. */
  "catalog.priceAlertPct": { schema: z.number().min(0).max(100_000), default: 10 },
  /** Stock at or below this value creates a low_stock Alert (null = disabled). */
  "catalog.lowStockThreshold": {
    schema: z.number().int().min(0).nullable(),
    default: null as number | null,
  },
  /** Create products the model is confident are new (otherwise they go to review). */
  "catalog.autoCreateProducts": { schema: z.boolean(), default: true },
  /** A product marked unavailable that appears quoted again is reactivated (with a warning). */
  "catalog.reactivateOnQuote": { schema: z.boolean(), default: true },
  /** Voice notes longer than this are NOT transcribed automatically (listen by hand). */
  "transcription.maxAutoDurationSeconds": {
    schema: z.number().int().min(10).max(3_600),
    default: 180,
  },
  /** Team members notified by WhatsApp (waId, digits only; they need an opt-in). */
  "notifications.whatsappRecipients": {
    schema: z.array(z.string().regex(/^\d{8,15}$/)).max(10),
    default: [] as string[],
  },
  /** Actionable events of this many minutes are grouped in ONE message per recipient. */
  "notifications.digestWindowMinutes": { schema: z.number().int().min(1).max(240), default: 10 },
  /** Max WhatsApp digests per recipient per hour; the excess waits for the next digest. */
  "notifications.maxPerHour": { schema: z.number().int().min(1).max(60), default: 4 },
  /** Critical errors skip the digest window, with their own hourly cap. */
  "notifications.criticalMaxPerHour": { schema: z.number().int().min(0).max(20), default: 3 },
  /**
   * Approved template for digests outside the 24 h window (null → panel only then).
   * bodyParam: the template has ONE body variable that receives the digest text.
   */
  "notifications.template": {
    schema: z
      .object({
        name: z.string().regex(/^[a-z0-9_]{1,512}$/),
        languageCode: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
        bodyParam: z.boolean(),
      })
      .nullable(),
    default: null as { name: string; languageCode: string; bodyParam: boolean } | null,
  },
  /**
   * GLOBAL switch for automatic replies to contacts (phase 9 M6, user decision): off = the bot
   * answers nobody (like every chat in human mode). Lists are still processed, the catalog is
   * updated and the TEAM keeps getting notifications; the opt-out confirmation (compliance)
   * and replies written by a person still go out.
   */
  "bot.autoRepliesEnabled": { schema: z.boolean(), default: true },
  /**
   * Business hours (phase 9 M6): outside them, NON-critical WhatsApp digests to the team wait
   * until opening (critical ones still go out) and the panel shows "fuera de horario".
   * null = always open. days: 0 = Sunday … 6 = Saturday. Times "HH:MM" in `timeZone`;
   * close may be earlier than open (overnight). An automatic "we reply tomorrow" answer to
   * contacts is a FUTURE option, off by default (not implemented).
   */
  businessHours: {
    schema: businessHoursSchema.nullable(),
    default: null as BusinessHours | null,
  },
  /** Acknowledge supplier lists by WhatsApp ("Recibimos tu lista…"). OFF by default, ON in demo mode. */
  "bot.supplierAck": { schema: z.boolean(), default: false },
  /**
   * Human takeover (phase 7, ADR-016): after a person replies (panel or WhatsApp Business
   * app), automatic replies to that contact stay paused this long (extended by each human
   * message). Up to 7 days.
   */
  "coexistence.humanTakeoverMinutes": {
    schema: z.number().int().min(1).max(10_080),
    default: 120,
  },
  /** Whole-message keywords (case/accent-insensitive) that opt a contact OUT (phase 7, ADR-017). */
  "optOut.keywords": {
    schema: z.array(z.string().min(1).max(40)).min(1).max(20),
    default: ["BAJA", "STOP", "CANCELAR", "UNSUBSCRIBE"] as string[],
  },
  /** Whole-message keywords that opt a previously opted-out contact back IN. */
  "optIn.keywords": {
    schema: z.array(z.string().min(1).max(40)).min(1).max(20),
    default: ["ALTA", "START"] as string[],
  },
  /** The opt-out instruction is appended to an auto reply at most this often per contact. */
  "optOut.instructionReminderDays": { schema: z.number().int().min(1).max(365), default: 30 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export interface CatalogSettings {
  maxIncreasePct: number;
  maxDecreasePct: number;
  priceAlertPct: number;
  lowStockThreshold: number | null;
  autoCreateProducts: boolean;
  reactivateOnQuote: boolean;
}

export interface ResolvedSettings {
  values: Record<SettingKey, unknown>;
  /** Keys whose stored value was invalid (default used instead). */
  invalidKeys: SettingKey[];
}

/** Merges stored rows over the defaults, validating each key (pure). */
export function resolveSettings(stored: ReadonlyMap<string, unknown>): ResolvedSettings {
  const values = {} as Record<SettingKey, unknown>;
  const invalidKeys: SettingKey[] = [];
  for (const key of SETTING_KEYS) {
    const def = SETTING_DEFINITIONS[key];
    if (!stored.has(key)) {
      values[key] = def.default;
      continue;
    }
    const parsed = def.schema.safeParse(stored.get(key));
    if (parsed.success) values[key] = parsed.data;
    else {
      values[key] = def.default;
      invalidKeys.push(key);
    }
  }
  return { values, invalidKeys };
}

export function catalogSettings(values: Record<SettingKey, unknown>): CatalogSettings {
  return {
    maxIncreasePct: values["catalog.maxIncreasePct"] as number,
    maxDecreasePct: values["catalog.maxDecreasePct"] as number,
    priceAlertPct: values["catalog.priceAlertPct"] as number,
    lowStockThreshold: values["catalog.lowStockThreshold"] as number | null,
    autoCreateProducts: values["catalog.autoCreateProducts"] as boolean,
    reactivateOnQuote: values["catalog.reactivateOnQuote"] as boolean,
  };
}

export const DEFAULT_CATALOG_SETTINGS: CatalogSettings = catalogSettings(
  resolveSettings(new Map()).values,
);
