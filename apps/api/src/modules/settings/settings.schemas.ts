import { z } from "zod";

/**
 * No-code rules (Setting table: key → JSON value). Defaults live in code; a row in the DB
 * overrides its key. Every key is validated with Zod here — the panel (phase 9) writes
 * through the same schemas. An invalid stored value falls back to the default (and is
 * reported), so a bad edit can never break ingestion.
 */

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
  /** Acknowledge supplier lists by WhatsApp ("Recibimos tu lista…"). OFF by default, ON in demo mode. */
  "bot.supplierAck": { schema: z.boolean(), default: false },
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
