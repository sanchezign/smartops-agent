/**
 * wa:media:retry — re-enqueues media downloads that ended `failed` (e.g. after renewing
 * WHATSAPP_ACCESS_TOKEN). Resets them to `pending` and sends a new job. Media ids from
 * webhooks expire after 7 days: older media will fail again with media_not_found.
 *
 *   pnpm --filter @smartops/api wa:media:retry --all-failed [--limit 100]
 *   pnpm --filter @smartops/api wa:media:retry --id <mediaFileId> [--id <mediaFileId>]
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { enqueueMediaDownload, startBoss } from "../src/jobs/boss.js";
import { createMediaRepository } from "../src/modules/media/media.repository.js";

const { values } = parseArgs({
  options: {
    id: { type: "string", multiple: true, default: [] },
    "all-failed": { type: "boolean", default: false },
    limit: { type: "string", default: "100" },
  },
});

const env = loadEnv();
const logger = createLogger(env);

if (values.id.length === 0 && !values["all-failed"]) {
  logger.error("pass --id <mediaFileId> (repeatable) or --all-failed");
  process.exit(1);
}

const prisma = createPrismaClient(env.DATABASE_URL, logger);
const boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
try {
  // resetFailed does not store media, so the onStoredInTx hook is never called here.
  const ids = await createMediaRepository(prisma, { onStoredInTx: async () => {} }).resetFailed({
    ...(values.id.length > 0 ? { ids: values.id } : {}),
    limit: Number(values.limit),
  });
  for (const id of ids) await enqueueMediaDownload(boss, id);
  logger.info(
    { count: ids.length, ids },
    "failed media re-enqueued (the worker will download them)",
  );
  process.exitCode = 0;
} catch (err) {
  logger.error({ err }, "media retry failed");
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false, close: true });
  await prisma.$disconnect();
}
