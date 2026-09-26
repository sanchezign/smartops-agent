/**
 * wa:reply — a PERSON replies to a contact, exactly like the panel will (phase 7, ADR-016):
 * queues the message (author human; the 24 h window applies) and takes over the
 * conversation (automatic replies paused for coexistence.humanTakeoverMinutes). The worker
 * sends it. Stand-in for the panel until phase 9.
 *
 *   pnpm --filter @smartops/api wa:reply --to 59899000111 --text "Hola, te atiendo yo" --by ana
 *   ... --bsuid <UY.xxx> instead of --to; --wait to follow the status until final
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { AppError } from "../src/common/errors/app-error.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import {
  createEnqueueOutboundInTx,
  createScheduleBotResumeInTx,
  startBoss,
} from "../src/jobs/boss.js";
import { createConversationModeRepository } from "../src/modules/conversations/conversation-mode.repository.js";
import { createConversationModeService } from "../src/modules/conversations/conversation-mode.service.js";
import { createHumanReplyService } from "../src/modules/conversations/human-reply.service.js";
import { createOutboundRepository } from "../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../src/modules/messaging/outbound.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../src/modules/settings/settings.service.js";

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    bsuid: { type: "string" },
    text: { type: "string" },
    by: { type: "string" },
    wait: { type: "boolean", default: false },
  },
});

const env = loadEnv();
const logger = createLogger(env);

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

if (!values.to && !values.bsuid) fail("pass --to <phone digits> or --bsuid <UY.xxx>");
if (!values.text) fail("pass --text <message>");
if (!values.by) fail("pass --by <your name> (recorded in the history)");

const ref = values.to ? { waId: values.to.replace(/\D/g, "") } : { bsuid: values.bsuid as string };
const prisma = createPrismaClient(env.DATABASE_URL, logger);
const boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
const service = createHumanReplyService({
  outbound: createOutboundService({
    repository: createOutboundRepository(prisma, {
      enqueueOutboundInTx: createEnqueueOutboundInTx(boss),
    }),
    // Sending is done by the worker; the CLI only queues.
    client: {
      send: () => Promise.reject(new Error("wa:reply does not send inline (the worker does)")),
    },
  }),
  mode: createConversationModeService({
    repository: createConversationModeRepository(prisma, {
      scheduleBotResumeInTx: createScheduleBotResumeInTx(boss),
    }),
    settings,
  }),
});

try {
  const result = await service.reply(
    ref,
    { text: values.text },
    { label: `cli:${values.by}` },
    logger,
  );
  logger.info(
    {
      messageId: result.messageId,
      conversationId: result.conversationId,
      mode: result.takeover.state.mode,
      humanUntil: result.takeover.state.humanUntil,
      canceledAutoReplies: result.takeover.canceledMessages,
    },
    "human reply queued; bot paused for this conversation",
  );

  if (values.wait) {
    const final = new Set(["read", "failed"]);
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      const message = await prisma.message.findUniqueOrThrow({
        where: { id: result.messageId },
        select: { status: true, waMessageId: true, errorCode: true },
      });
      if (message.status !== last) {
        logger.info(message, `status: ${message.status}`);
        last = message.status;
      }
      if (final.has(message.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
} catch (err) {
  if (err instanceof AppError) fail(`${err.code}: ${err.message}`);
  throw err;
} finally {
  await boss.stop({ graceful: false });
  await prisma.$disconnect();
}
