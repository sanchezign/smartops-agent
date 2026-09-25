import type { PrismaClient } from "../../common/db.js";
import type { Logger } from "../../common/logger.js";
import {
  catalogSettings,
  resolveSettings,
  SETTING_KEYS,
  type CatalogSettings,
  type SettingKey,
} from "./settings.schemas.js";

/** Settings rows (key → JSON). The only place in the flow that touches the settings table. */
export interface SettingsRepository {
  rows(keys: readonly string[]): Promise<Map<string, unknown>>;
}

export function createSettingsRepository(prisma: PrismaClient): SettingsRepository {
  return {
    async rows(keys) {
      const rows = await prisma.setting.findMany({
        where: { key: { in: [...keys] } },
        select: { key: true, value: true },
      });
      return new Map(rows.map((r) => [r.key, r.value as unknown]));
    },
  };
}

export interface SettingsService {
  /** Every rule (defaults + validated overrides), for /internal/rules and snapshots. */
  getAll(log: Logger): Promise<Record<SettingKey, unknown>>;
  getCatalogSettings(log: Logger): Promise<CatalogSettings>;
}

export function createSettingsService(deps: { repository: SettingsRepository }): SettingsService {
  async function load(log: Logger) {
    const resolved = resolveSettings(await deps.repository.rows(SETTING_KEYS));
    if (resolved.invalidKeys.length > 0) {
      log.warn({ keys: resolved.invalidKeys }, "invalid stored settings ignored (defaults used)");
    }
    return resolved.values;
  }
  return {
    getAll: load,
    async getCatalogSettings(log) {
      return catalogSettings(await load(log));
    },
  };
}
