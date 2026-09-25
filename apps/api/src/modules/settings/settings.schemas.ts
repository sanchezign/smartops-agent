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
