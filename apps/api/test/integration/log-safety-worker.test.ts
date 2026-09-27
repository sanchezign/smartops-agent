import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { TEST_WHATSAPP_ENV } from "../helpers/build-app.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";
import {
  createCaptureLogger,
  digitRunsInStrings,
  sensitiveFixtureValues,
} from "../helpers/log-capture.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Log safety on the WORKER side (phase 10 M6, user addendum C): every WhatsApp fixture (texts,
 * media with signed URLs, statuses incl. a failed one with Meta's error, echoes, BSUID-only
 * senders, unsupported types) goes through the real webhook processing with the production
 * logger at "trace". No full phone, BSUID, message text, caption or media URL may appear.
 */

describe.skipIf(!testDatabaseUrl)("log safety (worker: webhook processing)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await resetWhatsAppTables(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("processing every fixture logs masked identifiers only", async () => {
    const { logger, lines } = createCaptureLogger({ NODE_ENV: "test" }, "worker");
    const webhooks = createWhatsAppWebhookRepository(prisma);
    const service = createWhatsAppIngestService({
      repository: createWhatsAppIngestRepository(prisma, { enqueueMediaInTx: async () => {} }),
      phoneNumberId: TEST_WHATSAPP_ENV.WHATSAPP_PHONE_NUMBER_ID,
    });

    const names = readdirSync(new URL("../fixtures/whatsapp/", import.meta.url))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""));
    for (const name of names) {
      const payload = whatsappFixtureJson(name);
      const saved = await webhooks.saveEvent({
        bodySha256: createHash("sha256").update(name).digest("hex"),
        payload: payload as never,
      });
      if (saved.duplicate) throw new Error(`duplicate fixture ${name}`);
      await service.processEvent(saved.id, logger);
    }

    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(names.length); // really logged
    expect(all).toMatch(/\d{3}\*+\d{3}/); // masked phones are there…
    const leaks = sensitiveFixtureValues().filter((s) => all.includes(s));
    expect(leaks).toEqual([]); // …the full ones are not
    expect(digitRunsInStrings(lines)).toEqual([]);
    expect(all).not.toMatch(/lookaside|fbsbx\.com/);
  });
});
