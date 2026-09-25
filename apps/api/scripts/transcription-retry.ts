/**
 * wa:transcription:retry — re-enqueues transcriptions that ended `failed` (e.g. after
 * fixing TRANSCRIPTION_API_KEY or once the provider's rate limit resets).
 *
 *   pnpm --filter @smartops/api wa:transcription:retry --all-failed [--limit 100]
 *   pnpm --filter @smartops/api wa:transcription:retry --id <mediaFileId> [--id …]
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { enqueueTranscription, startBoss } from "../src/jobs/boss.js";
import { createTranscriptionRepository } from "../src/modules/transcription/transcription.repository.js";

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
  const ids = await createTranscriptionRepository(prisma).resetFailed({
    ...(values.id.length > 0 ? { mediaFileIds: values.id } : {}),
    limit: Number(values.limit),
  });
  for (const id of ids) await enqueueTranscription(boss, id);
  logger.info({ count: ids.length, ids }, "failed transcriptions re-enqueued");
  process.exitCode = 0;
} catch (err) {
  logger.error({ err }, "transcription retry failed");
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false, close: true });
  await prisma.$disconnect();
}
