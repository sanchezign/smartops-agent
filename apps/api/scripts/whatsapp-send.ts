/**
 * wa:send — queues an outbound WhatsApp message through the real outbound service
 * (24h window + opt-in rules, pending Message + job). The worker sends it.
 *
 *   pnpm --filter @smartops/api wa:send text --to 59899000111 --text "Recibimos tu lista"
 *   pnpm --filter @smartops/api wa:send template --to 59899000111 --name hello_world --lang en_US
 *   pnpm --filter @smartops/api wa:send template --to 59899000222 --name hello_world \
 *        --lang en_US --opt-in-confirmed            # records a MANUAL opt-in first (tests)
 *   ... --param "value" (repeatable, template body parameters) --key <idempotencyKey>
 *   ... --bsuid <UY.xxx> instead of --to; --wait to follow the status until final
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { AppError } from "../src/common/errors/app-error.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { createEnqueueOutboundInTx, startBoss } from "../src/jobs/boss.js";
import { createOutboundRepository } from "../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../src/modules/messaging/outbound.service.js";
import type { SendContentInput } from "../src/modules/messaging/outbound.schemas.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string" },
    bsuid: { type: "string" },
    text: { type: "string" },
    name: { type: "string" },
    lang: { type: "string", default: "es" },
    param: { type: "string", multiple: true, default: [] },
    key: { type: "string" },
    author: { type: "string", default: "bot" },
    "opt-in-confirmed": { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
  },
});

const env = loadEnv();
const logger = createLogger(env);
const [kind] = positionals;

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

if (kind !== "text" && kind !== "template") fail("usage: wa:send text|template --to <phone> …");
if (!values.to && !values.bsuid) fail("pass --to <phone digits> or --bsuid <UY.xxx>");
if (values.author !== "bot" && values.author !== "human") fail("--author must be bot or human");

const ref = values.to ? { waId: values.to.replace(/\D/g, "") } : { bsuid: values.bsuid as string };
const content: SendContentInput =
  kind === "text"
    ? { kind: "text", body: values.text ?? fail("text needs --text") }
    : {
        kind: "template",
        name: values.name ?? fail("template needs --name"),
        languageCode: values.lang,
        ...(values.param.length > 0
          ? {
              components: [
                {
                  type: "body" as const,
                  parameters: values.param.map((text) => ({ type: "text" as const, text })),
                },
              ],
            }
          : {}),
      };

const prisma = createPrismaClient(env.DATABASE_URL, logger);
const boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
const service = createOutboundService({
  repository: createOutboundRepository(prisma, {
    enqueueOutboundInTx: createEnqueueOutboundInTx(boss),
  }),
  // Sending is done by the worker; the CLI only queues.
  client: {
    send: () => Promise.reject(new Error("wa:send does not send inline (the worker does)")),
  },
});

try {
  if (values["opt-in-confirmed"]) await service.recordManualOptIn(ref, logger);
  const result = await service.send(
    {
      recipient: ref,
      content,
      author: values.author,
      ...(values.key ? { idempotencyKey: values.key } : {}),
    },
    logger,
  );
  logger.info(result, result.duplicate ? "already queued (idempotency key)" : "queued");

  if (values.wait) {
    const final = new Set(["read", "failed"]);
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      const message = await prisma.message.findUniqueOrThrow({
        where: { id: result.messageId },
        select: { status: true, waMessageId: true, errorCode: true, errorMessage: true },
      });
      if (message.status !== last) {
        logger.info(message, `status: ${message.status}`);
        last = message.status;
      }
      if (final.has(message.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  process.exitCode = 0;
} catch (err) {
  if (err instanceof AppError) {
    logger.error({ code: err.code, details: err.details }, err.message);
  } else {
    logger.error({ err }, "send failed");
  }
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false, close: true });
  await prisma.$disconnect();
}
