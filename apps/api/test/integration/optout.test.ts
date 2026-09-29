import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import { buildInboundMessage, type SimContact } from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import { createEnqueueOutboundInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createOptOutRepository } from "../../src/modules/optout/optout.repository.js";
import { createOnComplianceMessageInTx } from "../../src/modules/optout/optout.service.js";
import { createOutboundRepository } from "../../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../../src/modules/messaging/outbound.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Opt-out / opt-in (phase 7 M3, ADR-017) against real Postgres + pg-boss: deterministic
 * detection at ingestion (no LLM, works even if n8n is down), one atomic transaction with
 * the message that triggered it, a single compliance reply, and the outbound service's
 * gates (send() + the worker's re-check) blocking every business-initiated message except
 * the compliance reply and a person's own reply.
 */

const log = pino({ level: "silent" });
const PHONE_NUMBER_ID = "100000000000001";
const business = {
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const supplier: SimContact = {
  waId: "59899000111",
  bsuid: fakeBsuidFor("59899000111"),
  name: "Proveedor",
};

describe.skipIf(!testDatabaseUrl)("opt-out / opt-in (Postgres + pg-boss)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;

  const settings = () => createSettingsService({ repository: createSettingsRepository(prisma) });
  const outboundRepository = () =>
    createOutboundRepository(prisma, { enqueueOutboundInTx: createEnqueueOutboundInTx(boss) });
  const optOutRepository = () => createOptOutRepository(prisma);
  const ingest = () =>
    createWhatsAppIngestService({
      repository: createWhatsAppIngestRepository(prisma, {
        enqueueMediaInTx: async () => {},
        emitMessageReadyInTx: async () => ({ created: true, eventId: null }),
        onComplianceMessageInTx: createOnComplianceMessageInTx({
          optOut: optOutRepository(),
          outbound: outboundRepository(),
          settings: settings(),
          logger: log,
        }),
      }),
      phoneNumberId: PHONE_NUMBER_ID,
    });

  let seq = 0;
  async function deliverText(text: string, from: SimContact = supplier) {
    seq += 1;
    const saved = await createWhatsAppWebhookRepository(prisma).saveEvent({
      bodySha256: String(seq).padStart(64, "0"),
      payload: buildInboundMessage(business, from, { type: "text", body: text }).payload,
    });
    return saved.duplicate ? null : ingest().processEvent(saved.id, log);
  }
  const contact = () => prisma.contact.findFirstOrThrow({ where: { waId: "59899000111" } });
  const consentEvents = async () =>
    prisma.contactConsentEvent.findMany({
      where: { contact: { waId: "59899000111" } },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await boss.deleteAllJobs(QUEUES.whatsappOutbound);
  });

  it("BAJA opts the contact out, records the event and queues ONE compliance confirmation", async () => {
    await deliverText("Lista septiembre: tornillo 6mm 12 UYU"); // opens the window, creates the contact
    await deliverText("BAJA");

    const c = await contact();
    expect(c.optOutAt).not.toBeNull();
    expect(c.optOutSource).toBe("keyword");
    expect(await consentEvents()).toEqual([
      expect.objectContaining({ kind: "opt_out", method: "keyword", keyword: "baja" }),
    ]);

    const confirmations = await prisma.message.findMany({
      where: { direction: "outbound", purpose: "compliance" },
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ status: "pending" });
    expect(confirmations[0]?.text).toMatch(/no recibirá más mensajes automáticos/);
  });

  it("with business.language = en the confirmations are in English (STOP / START)", async () => {
    // Settings are not truncated between tests: always remove it again.
    await prisma.setting.upsert({
      where: { key: "business.language" },
      create: { key: "business.language", value: "en" },
      update: { value: "en" },
    });
    let texts: (string | null)[];
    try {
      await deliverText("hello");
      await deliverText("STOP");
      await deliverText("START");
      const confirmations = await prisma.message.findMany({
        where: { direction: "outbound", purpose: "compliance" },
        orderBy: { createdAt: "asc" },
      });
      texts = confirmations.map((m) => m.text);
    } finally {
      await prisma.setting.deleteMany({ where: { key: "business.language" } });
    }
    expect(texts).toEqual([
      "Done: you won't receive more automatic messages from us. To receive them again, reply START.",
      "Done: you'll receive our automatic messages again.",
    ]);
  });

  it("a repeated BAJA does not opt out twice nor send a second confirmation", async () => {
    await deliverText("hola");
    await deliverText("BAJA");
    await deliverText("Baja");
    expect(await consentEvents()).toHaveLength(1);
    expect(
      await prisma.message.count({ where: { direction: "outbound", purpose: "compliance" } }),
    ).toBe(1);
  });

  it("ALTA re-enables an opted-out contact and confirms it", async () => {
    await deliverText("hola");
    await deliverText("BAJA");
    await deliverText("ALTA");
    const c = await contact();
    expect(c.optOutAt).toBeNull();
    expect(c.optOutSource).toBeNull();
    const kinds = (await consentEvents()).map((e) => e.kind);
    expect(kinds).toEqual(["opt_out", "opt_in"]);
    const confirmations = await prisma.message.findMany({
      where: { direction: "outbound", purpose: "compliance" },
      orderBy: { createdAt: "asc" },
    });
    expect(confirmations.map((m) => m.text)).toEqual([
      expect.stringMatching(/no recibirá más/),
      expect.stringMatching(/volverá a recibir/),
    ]);
  });

  it("ALTA on a contact that was never opted out is a no-op", async () => {
    await deliverText("hola");
    await deliverText("ALTA");
    expect(await consentEvents()).toEqual([]);
    expect(await prisma.message.count({ where: { direction: "outbound" } })).toBe(0);
  });

  it("an ambiguous phrase flags a possible_opt_out alert and does NOT opt out", async () => {
    await deliverText("hola");
    await deliverText("ya no trabajo con ustedes");
    const c = await contact();
    expect(c.optOutAt).toBeNull();
    const alerts = await prisma.alert.findMany({ where: { type: "possible_opt_out" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toMatch(/Possible opt-out/);
    // The panel writes it in its language from the matched phrase (phase 13).
    expect(alerts[0]?.payload).toMatchObject({ matched: expect.any(String) });
  });

  it("a price list from an opted-out supplier is still ingested (no gate on inbound processing)", async () => {
    await deliverText("hola");
    await deliverText("BAJA");
    const result = await deliverText("Lista octubre: tornillo 6mm 14 UYU, tuerca 6mm 6 UYU");
    expect(result).toMatchObject({ outcome: "processed", messagesCreated: 1 });
  });

  describe("outbound gates (send + worker re-check)", () => {
    async function optOutViaKeyword() {
      await deliverText("hola");
      await deliverText("BAJA");
      return contact();
    }

    it("send() refuses auto_reply, template and team_notification, but allows compliance and human", async () => {
      const c = await optOutViaKeyword();
      const outbound = createOutboundService({
        repository: outboundRepository(),
        client: {
          send: async () => ({ wamid: "w", messageStatus: null, waId: null, userId: null }),
        },
      });
      const text = { kind: "text" as const, body: "Hola" };
      await expect(
        outbound.send({ recipient: { waId: c.waId! }, content: text, author: "bot" }, log),
      ).rejects.toMatchObject({ code: "OPTED_OUT" });
      await expect(
        outbound.send(
          {
            recipient: { waId: c.waId! },
            content: text,
            author: "bot",
            purpose: "team_notification",
          },
          log,
        ),
      ).rejects.toMatchObject({ code: "OPTED_OUT" });
      // Allowed: a human reply and another compliance message.
      await outbound.send({ recipient: { waId: c.waId! }, content: text, author: "human" }, log);
      await outbound.send(
        { recipient: { waId: c.waId! }, content: text, author: "bot", purpose: "compliance" },
        log,
      );
    });

    it("the worker re-checks: a contact who opts out AFTER queuing fails the job as opted_out", async () => {
      await deliverText("hola");
      const c = await contact();
      const outbound = createOutboundService({
        repository: outboundRepository(),
        client: {
          send: async () => ({ wamid: "w", messageStatus: null, waId: null, userId: null }),
        },
      });
      const queued = await outbound.send(
        {
          recipient: { waId: c.waId! },
          content: { kind: "text", body: "Recibimos tu lista" },
          author: "bot",
        },
        log,
      );
      await deliverText("BAJA"); // opts out AFTER the message was queued
      const result = await outbound.processOutbound(queued.messageId, log, { finalAttempt: false });
      expect(result).toEqual({ outcome: "failed", reason: "opted_out" });
      expect(
        await prisma.message.findUniqueOrThrow({ where: { id: queued.messageId } }),
      ).toMatchObject({ status: "failed", errorCode: "opted_out" });
    });

    it("appends the opt-out instruction to the first auto reply, then not again within the reminder window", async () => {
      await deliverText("hola");
      const c = await contact();
      // Upsert: settings are not truncated between tests or runs.
      await prisma.setting.upsert({
        where: { key: "optOut.instructionReminderDays" },
        create: { key: "optOut.instructionReminderDays", value: 30 },
        update: { value: 30 },
      });
      const outbound = createOutboundService({
        repository: outboundRepository(),
        client: {
          send: async () => ({ wamid: "w", messageStatus: null, waId: null, userId: null }),
        },
        settings: settings(),
      });
      const first = await outbound.send(
        {
          recipient: { waId: c.waId! },
          content: { kind: "text", body: "Recibimos tu lista" },
          author: "bot",
        },
        log,
      );
      const firstMsg = await prisma.message.findUniqueOrThrow({ where: { id: first.messageId } });
      expect(firstMsg.text).toMatch(/Responda BAJA/);

      const second = await outbound.send(
        {
          recipient: { waId: c.waId! },
          content: { kind: "text", body: "Otro mensaje" },
          author: "bot",
          idempotencyKey: "second-auto-reply",
        },
        log,
      );
      const secondMsg = await prisma.message.findUniqueOrThrow({ where: { id: second.messageId } });
      expect(secondMsg.text).toBe("Otro mensaje"); // no footer: reminded recently
    });
  });
});
