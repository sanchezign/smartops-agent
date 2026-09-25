/**
 * n8n:replay — sends failed "message.ready" events to n8n again (after an outage longer
 * than the ~24 h of automatic retries, or after fixing the n8n workflow).
 *
 *   pnpm --filter @smartops/api n8n:replay [--since 2026-09-26T00:00:00Z] [--limit 100]
 *
 * Safe to repeat: every endpoint n8n calls is idempotent.
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { enqueueN8nDelivery, startBoss } from "../src/jobs/boss.js";
import { createIntegrationEventRepository } from "../src/modules/integration/integration-event.repository.js";

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    limit: { type: "string", default: "100" },
  },
});

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL, logger);
const boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
try {
  const repository = createIntegrationEventRepository(prisma);
  const ids = await repository.findFailed({
    ...(values.since ? { since: new Date(values.since) } : {}),
    limit: Number(values.limit),
  });
  await repository.requeue(ids, { redelivery: false, resetAttempts: true });
  for (const id of ids) await enqueueN8nDelivery(boss, id);
  logger.info(
    { count: ids.length, deliveryEnabled: env.N8N_DELIVERY_ENABLED },
    "failed n8n events re-enqueued",
  );
  process.exitCode = 0;
} catch (err) {
  logger.error({ err }, "n8n replay failed");
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false, close: true });
  await prisma.$disconnect();
}
