/**
 * wa:conversation — bot / human mode of a conversation (phase 7, ADR-016). Stands in for
 * the panel buttons until phase 9. Runs the same service as the panel will.
 *
 *   pnpm --filter @smartops/api wa:conversation status --to 59899000111
 *   pnpm --filter @smartops/api wa:conversation pause  --to 59899000111 --minutes 60 --by ana
 *   pnpm --filter @smartops/api wa:conversation pause  --to 59899000111 --indefinite --by ana
 *   pnpm --filter @smartops/api wa:conversation resume --to 59899000111 --by ana
 *   ... --bsuid <UY.xxx> instead of --to
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { AppError } from "../src/common/errors/app-error.js";
import { createLogger } from "../src/common/logger.js";
import { maskPhone, maskUserId } from "../src/common/phone.js";
import { loadEnv } from "../src/config/env.js";
import { createScheduleBotResumeInTx, startBoss } from "../src/jobs/boss.js";
import { createConversationModeRepository } from "../src/modules/conversations/conversation-mode.repository.js";
import { createConversationModeService } from "../src/modules/conversations/conversation-mode.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../src/modules/settings/settings.service.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string" },
    bsuid: { type: "string" },
    minutes: { type: "string" },
    indefinite: { type: "boolean", default: false },
    by: { type: "string" },
  },
});

const env = loadEnv();
const logger = createLogger(env);
const [action] = positionals;

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

if (action !== "status" && action !== "pause" && action !== "resume")
  fail(
    "usage: wa:conversation status|pause|resume --to <phone> [--minutes N | --indefinite] --by <name>",
  );
if (!values.to && !values.bsuid) fail("pass --to <phone digits> or --bsuid <UY.xxx>");
if (action !== "status" && !values.by) fail("pass --by <your name> (recorded in the history)");

let minutes: number | null = null;
if (action === "pause") {
  if (values.indefinite === (values.minutes !== undefined))
    fail("pause needs exactly one of --minutes N or --indefinite");
  if (values.minutes !== undefined) {
    minutes = Number(values.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080)
      fail("--minutes must be an integer between 1 and 10080");
  }
}

const ref = values.to ? { waId: values.to.replace(/\D/g, "") } : { bsuid: values.bsuid as string };
const who = values.to ? maskPhone(ref.waId as string) : maskUserId(values.bsuid as string);
const actor = { label: `cli:${values.by ?? ""}` };

const prisma = createPrismaClient(env.DATABASE_URL, logger);
const boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
const service = createConversationModeService({
  repository: createConversationModeRepository(prisma, {
    scheduleBotResumeInTx: createScheduleBotResumeInTx(boss),
  }),
  settings: createSettingsService({ repository: createSettingsRepository(prisma) }),
});

try {
  if (action === "pause") await service.pause(ref, { minutes }, actor, logger);
  if (action === "resume") await service.resume(ref, actor, logger);
  const view = await service.status(ref);
  if (!view) fail(`no conversation for ${who}`);
  logger.info(
    {
      contact: who,
      mode: view.mode,
      humanUntil: view.humanUntil,
      lastChange: view.lastChange,
    },
    view.mode === "bot"
      ? "bot active"
      : view.humanUntil
        ? "human mode (bot paused until humanUntil)"
        : "human mode (until reactivated by hand)",
  );
} catch (err) {
  if (err instanceof AppError) fail(`${err.code}: ${err.message}`);
  throw err;
} finally {
  await boss.stop({ graceful: false });
  await prisma.$disconnect();
}
