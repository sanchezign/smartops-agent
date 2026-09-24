import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import {
  parseWhatsAppWebhook,
  type ParsedInboundMessage,
  type ParsedStatus,
} from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Real Postgres: proves the idempotency and race handling that fakes cannot
 * (unique constraints, CHECKs, concurrent upserts). Skipped without TEST_DATABASE_URL.
 */

const PHONE_NUMBER_ID = "100000000000001";
const log = pino({ level: "silent" });

function inboundFrom(fixture: string): ParsedInboundMessage {
  const parsed = parseWhatsAppWebhook(whatsappFixtureJson(fixture));
  const message = parsed.recognized ? parsed.changes[0]?.messages[0] : undefined;
  if (!message) throw new Error(`${fixture}: no message`);
  return message;
}

function status(waMessageId: string, value: string, overrides: Partial<ParsedStatus> = {}) {
  return {
    waMessageId,
    status: value,
    timestamp: new Date(),
    recipientWaId: "59899000111",
    recipientUserId: null,
    errors: [],
    pricing: null,
    ...overrides,
  } satisfies ParsedStatus;
}

describe.skipIf(!testDatabaseUrl)("WhatsApp ingestion against Postgres", () => {
  let prisma: PrismaClient;
  let repository: ReturnType<typeof createWhatsAppIngestRepository>;
  let webhookRepository: ReturnType<typeof createWhatsAppWebhookRepository>;
  let eventId: string;
  const enqueuedMedia: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrisma();
    repository = createWhatsAppIngestRepository(prisma, {
      enqueueMediaInTx: async (_tx, mediaFileId) => {
        enqueuedMedia.push(mediaFileId);
      },
    });
    webhookRepository = createWhatsAppWebhookRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    const saved = await webhookRepository.saveEvent({ bodySha256: "0".repeat(64), payload: {} });
    if (saved.duplicate) throw new Error("unexpected duplicate");
    eventId = saved.id;
  });

  describe("inbound messages", () => {
    it("stores a message once; the second delivery is a duplicate", async () => {
      const message = inboundFrom("message-text");

      const first = await repository.ingestInboundMessage({ message, webhookEventId: eventId });
      const second = await repository.ingestInboundMessage({ message, webhookEventId: eventId });

      expect(first.outcome).toBe("created");
      expect(second.outcome).toBe("duplicate");
      expect(await prisma.message.count()).toBe(1);
      const stored = await prisma.message.findFirstOrThrow({ include: { conversation: true } });
      expect(stored).toMatchObject({
        direction: "inbound",
        author: "contact",
        type: "text",
        status: "received",
        webhookEventId: eventId,
      });
      expect(stored.conversation.lastInboundAt).toEqual(message.timestamp);
    });

    it("dedupes the same message processed concurrently", async () => {
      const message = inboundFrom("message-text");
      const results = await Promise.all(
        [1, 2, 3].map(() => repository.ingestInboundMessage({ message, webhookEventId: eventId })),
      );

      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(await prisma.message.count()).toBe(1);
    });

    it("creates one contact and one conversation for concurrent messages of a new contact", async () => {
      const base = inboundFrom("message-text");
      const messages = ["A", "B", "C"].map((suffix) => ({
        ...base,
        waMessageId: `${base.waMessageId}_${suffix}`,
      }));

      await Promise.all(
        messages.map((message) =>
          repository.ingestInboundMessage({ message, webhookEventId: eventId }),
        ),
      );

      expect(await prisma.message.count()).toBe(3);
      expect(await prisma.contact.count()).toBe(1);
      expect(await prisma.conversation.count()).toBe(1);
    });

    it("stores media metadata as pending and enqueues its download in the transaction", async () => {
      enqueuedMedia.length = 0;
      await repository.ingestInboundMessage({
        message: inboundFrom("message-document"),
        webhookEventId: eventId,
        mediaPlan: { status: "pending" },
      });
      const stored = await prisma.message.findFirstOrThrow({ include: { mediaFile: true } });
      expect(stored.text).toBe("Lista septiembre");
      expect(stored.mediaFile).toMatchObject({
        waMediaId: "900000000000002",
        mimeType: "application/pdf",
        filename: "lista-precios.pdf",
        status: "pending",
      });
      expect(enqueuedMedia).toEqual([stored.mediaFile?.id]);
    });

    it("does not enqueue media planned as skipped or rejected", async () => {
      enqueuedMedia.length = 0;
      await repository.ingestInboundMessage({
        message: inboundFrom("message-image"),
        webhookEventId: eventId,
        mediaPlan: { status: "rejected", rejectReason: "unsupported_mime" },
      });
      expect(await prisma.mediaFile.findFirstOrThrow()).toMatchObject({
        status: "rejected",
        rejectReason: "unsupported_mime",
      });
      expect(enqueuedMedia).toEqual([]);
    });

    it("links a BSUID-only contact to its phone number when a later message has both", async () => {
      const bsuidOnly = inboundFrom("message-bsuid-only");
      await repository.ingestInboundMessage({ message: bsuidOnly, webhookEventId: eventId });
      let contact = await prisma.contact.findFirstOrThrow();
      expect(contact).toMatchObject({ waId: null, username: "ferreteria.sur" });

      await repository.ingestInboundMessage({
        message: {
          ...bsuidOnly,
          waMessageId: "wamid.TEST_BSUID_0002",
          fromWaId: "59899000222",
        },
        webhookEventId: eventId,
      });

      expect(await prisma.contact.count()).toBe(1);
      contact = await prisma.contact.findFirstOrThrow();
      expect(contact).toMatchObject({ waId: "59899000222", bsuid: "UY.9Z8Y7X6W5V4U3T2S1R0Q" });
    });

    it("never moves conversation timestamps backwards (late delivery)", async () => {
      const base = inboundFrom("message-text");
      const newer = {
        ...base,
        waMessageId: "wamid.NEW",
        timestamp: new Date("2026-09-24T12:00:00Z"),
      };
      const older = {
        ...base,
        waMessageId: "wamid.OLD",
        timestamp: new Date("2026-09-24T11:00:00Z"),
      };

      await repository.ingestInboundMessage({ message: newer, webhookEventId: eventId });
      await repository.ingestInboundMessage({ message: older, webhookEventId: eventId });

      const conversation = await prisma.conversation.findFirstOrThrow();
      expect(conversation.lastInboundAt).toEqual(newer.timestamp);
      expect(conversation.lastMessageAt).toEqual(newer.timestamp);
    });

    it("enforces the contact identity CHECK (phone or BSUID required)", async () => {
      await expect(prisma.contact.create({ data: {} })).rejects.toThrow();
    });
  });

  describe("statuses", () => {
    async function outboundMessage(waMessageId: string) {
      const contact = await prisma.contact.create({ data: { waId: "59899000111" } });
      const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
      return prisma.message.create({
        data: {
          conversationId: conversation.id,
          waMessageId,
          direction: "outbound",
          type: "template",
          author: "bot",
          status: "pending",
        },
      });
    }

    it("moves an outbound message forward only, even out of order", async () => {
      const message = await outboundMessage("wamid.OUT");

      await repository.recordStatus({
        status: status("wamid.OUT", "delivered"),
        webhookEventId: eventId,
      });
      const late = await repository.recordStatus({
        status: status("wamid.OUT", "sent"),
        webhookEventId: eventId,
      });

      expect(late).toMatchObject({
        duplicate: false,
        messageId: message.id,
        messageUpdated: false,
      });
      expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe(
        "delivered",
      );
      expect(await prisma.messageStatusEvent.count({ where: { messageId: message.id } })).toBe(2);
    });

    it("records a re-delivered status once", async () => {
      await outboundMessage("wamid.OUT");
      const first = await repository.recordStatus({
        status: status("wamid.OUT", "read"),
        webhookEventId: eventId,
      });
      const again = await repository.recordStatus({
        status: status("wamid.OUT", "read"),
        webhookEventId: eventId,
      });

      expect(first.duplicate).toBe(false);
      expect(again.duplicate).toBe(true);
      expect(await prisma.messageStatusEvent.count()).toBe(1);
    });

    it("stores the Meta error of a failed status on the message", async () => {
      const message = await outboundMessage("wamid.OUT");
      await repository.recordStatus({
        status: status("wamid.OUT", "failed", {
          errors: [{ code: 131030, title: "Recipient phone number not in allowed list" }],
        }),
        webhookEventId: eventId,
      });

      expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
        status: "failed",
        errorCode: "131030",
        errorMessage: "Recipient phone number not in allowed list",
      });
    });

    it("keeps statuses of messages not sent through the API (messageId null)", async () => {
      const result = await repository.recordStatus({
        status: status("wamid.FROM_DASHBOARD", "failed"),
        webhookEventId: eventId,
      });
      expect(result).toMatchObject({ messageId: null, messageUpdated: false, duplicate: false });
      expect(await prisma.messageStatusEvent.findFirstOrThrow()).toMatchObject({
        waMessageId: "wamid.FROM_DASHBOARD",
        messageId: null,
      });
    });
  });

  describe("service + webhook events", () => {
    function service() {
      return createWhatsAppIngestService({ repository, phoneNumberId: PHONE_NUMBER_ID });
    }

    async function storeEvent(fixture: string, hash: string): Promise<string> {
      const saved = await webhookRepository.saveEvent({
        bodySha256: hash.padEnd(64, "0"),
        payload: whatsappFixtureJson(fixture),
      });
      if (saved.duplicate) throw new Error("unexpected duplicate");
      return saved.id;
    }

    it("processes an event once; re-running the job is a no-op", async () => {
      const id = await storeEvent("message-image", "1");

      expect((await service().processEvent(id, log)).outcome).toBe("processed");
      expect((await service().processEvent(id, log)).outcome).toBe("skipped");

      const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(event).toMatchObject({ status: "processed", attempts: 1 });
      expect(event.processedAt).toBeInstanceOf(Date);
      expect(await prisma.message.count()).toBe(1);
      expect(await prisma.mediaFile.count()).toBe(1);
    });

    it("marks the Meta dashboard sample as ignored without creating rows", async () => {
      const id = await storeEvent("dashboard-test-message", "2");

      expect((await service().processEvent(id, log)).outcome).toBe("ignored");
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "ignored",
        error: "no messages change for this phone_number_id",
      });
      expect(await prisma.contact.count()).toBe(0);
    });

    it("finds only stored-but-unenqueued events for the sweeper", async () => {
      const pending = await storeEvent("message-text", "3");
      const enqueued = await storeEvent("status-sent", "4");
      await webhookRepository.markEnqueued(enqueued);

      const ids = await webhookRepository.findUnenqueued({
        receivedBefore: new Date(Date.now() + 1_000),
        limit: 10,
      });
      // The beforeEach event (never enqueued) is also pending.
      expect(ids).toContain(pending);
      expect(ids).not.toContain(enqueued);
    });

    it("marks an event failed only while it is still received", async () => {
      const id = await storeEvent("message-text", "5");
      await repository.markEventFailed(id, "retries exhausted");
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        "failed",
      );

      const done = await storeEvent("message-image", "6");
      await service().processEvent(done, log);
      await repository.markEventFailed(done, "late dead letter");
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: done } })).status).toBe(
        "processed",
      );
    });
  });
});
