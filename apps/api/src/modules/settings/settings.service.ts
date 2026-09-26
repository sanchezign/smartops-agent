import type { PrismaClient } from "../../common/db.js";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  catalogSettings,
  resolveSettings,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type CatalogSettings,
  type SettingKey,
} from "./settings.schemas.js";

/** Settings rows (key → JSON). The only place in the flow that touches the settings table. */
export interface SettingsRepository {
  rows(keys: readonly string[]): Promise<Map<string, unknown>>;
  /** Writes one key and its audit row in one transaction (phase 8: panel, admin only). */
  upsert?(
    key: SettingKey,
    value: unknown,
    actor: { userId: string; requestId?: string },
  ): Promise<{ previous: unknown }>;
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
    async upsert(key, value, actor) {
      return prisma.$transaction(async (tx) => {
        const current = await tx.setting.findUnique({ where: { key }, select: { value: true } });
        const json = value as Prisma.InputJsonValue;
        await tx.setting.upsert({
          where: { key },
          create: { key, value: json, updatedById: actor.userId },
          update: { value: json, updatedById: actor.userId },
        });
        await tx.auditLog.create({
          data: {
            actorType: "user",
            userId: actor.userId,
            action: "setting.updated",
            entity: "setting",
            entityId: key,
            data: { from: (current?.value ?? null) as Prisma.InputJsonValue, to: json },
            requestId: actor.requestId ?? null,
          },
        });
        return { previous: current?.value ?? null };
      });
    },
  };
}

export interface SettingsService {
  /** Every rule (defaults + validated overrides), for /internal/rules and snapshots. */
  getAll(log: Logger): Promise<Record<SettingKey, unknown>>;
  getCatalogSettings(log: Logger): Promise<CatalogSettings>;
  /** Validates with the key's Zod schema (the same one used on read) and stores it. */
  set?(
    key: string,
    value: unknown,
    actor: { userId: string; requestId?: string },
  ): Promise<{ key: SettingKey; value: unknown; previous: unknown }>;
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
    async set(key, value, actor) {
      if (!(SETTING_KEYS as readonly string[]).includes(key))
        throw errors.notFound(`Unknown setting ${key}`);
      const settingKey = key as SettingKey;
      const parsed = SETTING_DEFINITIONS[settingKey].schema.safeParse(value);
      if (!parsed.success) throw errors.validation(parsed.error.issues, `Invalid value for ${key}`);
      if (!deps.repository.upsert) throw new Error("settings repository is read-only");
      const { previous } = await deps.repository.upsert(settingKey, parsed.data, actor);
      return { key: settingKey, value: parsed.data, previous };
    },
  };
}
