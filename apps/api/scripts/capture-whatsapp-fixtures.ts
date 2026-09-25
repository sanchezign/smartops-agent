/**
 * wa:fixtures:capture — turns real stored webhook deliveries (webhook_events) into
 * anonymized test fixtures (see scripts/fixtures/anonymize-webhook.ts).
 *
 *   pnpm --filter @smartops/api wa:fixtures:capture \
 *     --event <webhookEventId>=message-text --event <id>=status-sent [--out test/fixtures/whatsapp]
 *
 * All events of one run share the same identifier mapping. The run aborts (writes
 * nothing) if any original identifier survives anonymization.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import { createAnonymizer, type AnonymizedFixture } from "./fixtures/anonymize-webhook.js";

const { values } = parseArgs({
  options: {
    event: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "test/fixtures/whatsapp" },
  },
});

const env = loadEnv();
const logger = createLogger(env);

const specs = values.event.map((spec) => {
  const [id, name] = spec.split("=");
  if (!id || !name || !/^[a-z0-9-]+$/.test(name)) {
    logger.error(`invalid --event "${spec}" (use <webhookEventId>=<fixture-name>)`);
    process.exit(1);
  }
  return { id, name };
});
if (specs.length === 0) {
  logger.error("pass at least one --event <webhookEventId>=<fixture-name>");
  process.exit(1);
}

const prisma = createPrismaClient(env.DATABASE_URL, logger);
try {
  const anonymizer = createAnonymizer();
  const fixtures: AnonymizedFixture[] = [];
  for (const { id, name } of specs) {
    const event = await prisma.webhookEvent.findUnique({
      where: { id },
      select: { payload: true },
    });
    if (!event) throw new Error(`webhook event ${id} not found`);
    fixtures.push(anonymizer.anonymize(name, event.payload as never));
  }
  anonymizer.assertClean(fixtures);

  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  for (const fixture of fixtures) {
    writeFileSync(
      join(dir, `${fixture.name}.json`),
      `${JSON.stringify(fixture.payload, null, 2)}\n`,
    );
  }
  logger.info(
    { written: fixtures.map((f) => `${f.name}.json`), mapped: anonymizer.stats(), dir },
    "anonymized fixtures written (no original identifier left)",
  );
  process.exitCode = 0;
} catch (err) {
  logger.error({ err }, "fixture capture failed (nothing written)");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
