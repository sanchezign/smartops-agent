/**
 * wa:optout — manual opt-in / opt-out of a contact (phase 7, ADR-017). Stands in for the
 * panel's "opted-out contacts" screen until phase 9. Requires a reason (`--reason`),
 * recorded in the append-only `contact_consent_events` audit trail.
 *
 *   pnpm --filter @smartops/api wa:optout status  --to 59899000111
 *   pnpm --filter @smartops/api wa:optout out     --to 59899000111 --reason "pidió baja por teléfono" --by ana
 *   pnpm --filter @smartops/api wa:optout in      --to 59899000111 --reason "confirmó por email" --by ana
 *   ... --bsuid <UY.xxx> instead of --to; --source off_whatsapp (default manual)
 */
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { maskPhone, maskUserId } from "../src/common/phone.js";
import { loadEnv } from "../src/config/env.js";
import { createOptOutRepository } from "../src/modules/optout/optout.repository.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string" },
    bsuid: { type: "string" },
    reason: { type: "string" },
    by: { type: "string" },
    source: { type: "string", default: "manual" },
  },
});

const env = loadEnv();
const logger = createLogger(env);
const [action] = positionals;

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

if (action !== "status" && action !== "out" && action !== "in")
  fail("usage: wa:optout status|out|in --to <phone> [--reason <text> --by <name>]");
if (!values.to && !values.bsuid) fail("pass --to <phone digits> or --bsuid <UY.xxx>");
if (action !== "status") {
  if (!values.reason) fail("pass --reason <text> (recorded in the audit trail)");
  if (!values.by) fail("pass --by <your name>");
  if (values.source !== "manual" && values.source !== "off_whatsapp")
    fail("--source must be manual or off_whatsapp");
}

const ref = values.to ? { waId: values.to.replace(/\D/g, "") } : { bsuid: values.bsuid as string };
const who = values.to ? maskPhone(ref.waId as string) : maskUserId(values.bsuid as string);

const prisma = createPrismaClient(env.DATABASE_URL, logger);
const repository = createOptOutRepository(prisma);

try {
  if (action !== "status") {
    const found = await repository.find(ref);
    if (!found) fail(`no contact for ${who}`);
    const result = await repository.apply({
      contactId: found.contactId,
      kind: action === "out" ? "opt_out" : "opt_in",
      method: values.source,
      actor: { label: `cli:${values.by}` },
      note: values.reason,
      now: new Date(),
    });
    if (!result.changed) {
      logger.info(
        { contact: who },
        action === "out" ? "already opted out (no change)" : "was not opted out (no change)",
      );
    }
  }
  const view = await repository.find(ref);
  if (!view) fail(`no contact for ${who}`);
  logger.info(
    { contact: who, optOutAt: view.optOutAt, optOutSource: view.optOutSource },
    view.optOutAt ? "opted out" : "not opted out",
  );
} finally {
  await prisma.$disconnect();
}
