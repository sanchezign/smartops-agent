import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import {
  buildInboundMessage,
  buildMessageEcho,
  type SimContact,
} from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import { createScheduleBotResumeInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createConversationModeRepository } from "../../src/modules/conversations/conversation-mode.repository.js";
import {
  createConversationModeService,
  createOnHumanMessageInTx,
} from "../../src/modules/conversations/conversation-mode.service.js";
import { createHumanReplyService } from "../../src/modules/conversations/human-reply.service.js";
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
 * Coexistence echoes + human replies (phase 7 M2) against Postgres + pg-boss: an echo is
 * stored as the person's outbound message AND takes over the conversation in the same
 * transaction; duplicates, revokes and edits are idempotent; echoes never enter the
 * processing pipeline; the panel reply (`wa:reply`) takes over only if it can be sent.
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

describe.skipIf(!testDatabaseUrl)("coexistence echoes and human replies (Postgres)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let readyEvents: string[];

  const settings = () => createSettingsService({ repository: createSettingsRepository(prisma) });
  const modeRepository = () =>
    createConversationModeRepository(prisma, {
      scheduleBotResumeInTx: createScheduleBotResumeInTx(boss),
    });
  const ingest = () =>
    createWhatsAppIngestService({
      repository: createWhatsAppIngestRepository(prisma, {
        enqueueMediaInTx: async () => {},
        emitMessageReadyInTx: async (_tx, input) => {
          readyEvents.push("messageId" in input ? input.messageId : input.mediaFileId);
          return { created: true, eventId: null };
        },
        onHumanMessageInTx: createOnHumanMessageInTx({
          repository: modeRepository(),
          settings: settings(),
          logger: log,
        }),
      }),
      phoneNumberId: PHONE_NUMBER_ID,
    });

  let seq = 0;
  async function deliver(payload: unknown) {
    seq += 1;
    const saved = await createWhatsAppWebhookRepository(prisma).saveEvent({
      bodySha256: String(seq).padStart(64, "0"),
      payload,
    });
    return saved.duplicate ? null : ingest().processEvent(saved.id, log);
  }
  const conversationOf = (waId: string) =>
    prisma.conversation.findFirstOrThrow({ where: { contact: { waId } } });

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
    await boss.deleteAllJobs(QUEUES.conversationBotResume);
    readyEvents = [];
  });

  it("an echo is stored as the person's message, pauses the bot and cancels the queued auto reply — never enters the pipeline", async () => {
    await deliver(buildInboundMessage(business, supplier, { type: "text", body: "Hola" }).payload);
    expect(readyEvents).toHaveLength(1); // the contact's message goes to n8n
    const contact = await prisma.contact.findUniqueOrThrow({ where: { waId: "59899000111" } });
    const { messageId: queued } = await createOutboundRepository(prisma, {
      enqueueOutboundInTx: async () => {},
    }).createOutbound({
      contactId: contact.id,
      type: "text",
      text: "Recibimos tu lista",
      author: "bot",
      purpose: "auto_reply",
      request: {},
    });

    const { wamid, payload } = buildMessageEcho(business, "59899000111", {
      type: "text",
      body: "Te atiendo yo",
    });
    const result = await deliver(payload);
    expect(result).toMatchObject({ outcome: "processed", echoesStored: 1, messagesCreated: 0 });

    const echo = await prisma.message.findUniqueOrThrow({ where: { waMessageId: wamid } });
    expect(echo).toMatchObject({
      direction: "outbound",
      author: "human",
      purpose: "human",
      status: "sent",
      text: "Te atiendo yo",
      mediaFileId: null,
    });
    expect(readyEvents).toHaveLength(1); // the echo did NOT go to n8n
    expect(await prisma.message.findUniqueOrThrow({ where: { id: queued } })).toMatchObject({
      status: "canceled",
      errorCode: "human_takeover",
    });
    const conversation = await conversationOf("59899000111");
    expect(conversation.mode).toBe("human");
    expect(conversation.humanUntil!.getTime() - Date.now()).toBeGreaterThan(119 * 60_000);
    expect(
      await prisma.conversationModeChange.findMany({ where: { conversationId: conversation.id } }),
    ).toEqual([
      expect.objectContaining({
        reason: "human_reply_app",
        actorLabel: "whatsapp-business-app",
        messageId: echo.id,
      }),
    ]);
  });

  it("a re-delivered echo is stored and applied once", async () => {
    const { payload } = buildMessageEcho(business, "59899000111", { type: "text", body: "Hola" });
    await deliver(payload);
    const again = await deliver(payload);
    expect(again).toMatchObject({ echoesStored: 0 });
    expect(await prisma.message.count({ where: { author: "human" } })).toBe(1);
    expect(await prisma.conversationModeChange.count()).toBe(1);
  });

  it("an echo to a contact who never wrote creates the contact WITHOUT opt-in", async () => {
    await deliver(
      buildMessageEcho(business, "59899000222", { type: "text", body: "Hola, soy Ana" }).payload,
    );
    const contact = await prisma.contact.findUniqueOrThrow({ where: { waId: "59899000222" } });
    expect(contact).toMatchObject({ optInAt: null, kind: "unknown" });
    expect((await conversationOf("59899000222")).mode).toBe("human");
  });

  it("image echo: metadata only (no media file, no download)", async () => {
    await deliver(
      buildMessageEcho(business, "59899000111", {
        type: "image",
        media: { id: "123", mimeType: "image/jpeg", sha256: "x", caption: "Modelo nuevo" },
      }).payload,
    );
    const echo = await prisma.message.findFirstOrThrow({ where: { author: "human" } });
    expect(echo).toMatchObject({ type: "image", text: "Modelo nuevo", mediaFileId: null });
    expect(echo.raw).toMatchObject({ media: { waMediaId: "123", mimeType: "image/jpeg" } });
    expect(await prisma.mediaFile.count()).toBe(0);
  });

  it("revoke and edit update the original message (idempotent) without a new takeover", async () => {
    const { wamid } = buildMessageEcho(business, "59899000111", { type: "text", body: "x" });
    await deliver(
      buildMessageEcho(business, "59899000111", { type: "text", body: "Precio: 100" }, { wamid })
        .payload,
    );
    const edit = buildMessageEcho(business, "59899000111", {
      type: "edit",
      originalWamid: wamid,
      body: "Precio: 120",
    });
    await deliver(edit.payload);
    await deliver(edit.payload); // same edit re-delivered (different body hash in this test)
    await deliver(
      buildMessageEcho(business, "59899000111", { type: "revoke", originalWamid: wamid }).payload,
    );
    const original = await prisma.message.findUniqueOrThrow({ where: { waMessageId: wamid } });
    expect(original.text).toBe("Precio: 120");
    expect(original.editedAt).not.toBeNull();
    expect(original.revokedAt).not.toBeNull();
    expect((original.raw as { edits: unknown[] }).edits).toEqual([
      expect.objectContaining({ wamid: edit.wamid, previousText: "Precio: 100" }),
    ]);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.conversationModeChange.count()).toBe(1);
  });

  it("revoke of an unknown message is ignored without failing the delivery", async () => {
    const result = await deliver(
      buildMessageEcho(business, "59899000111", { type: "revoke", originalWamid: "wamid.NOPE" })
        .payload,
    );
    expect(result).toMatchObject({ outcome: "processed" });
    expect(await prisma.message.count()).toBe(0);
  });

  describe("human reply from the panel (wa:reply)", () => {
    const replyService = () =>
      createHumanReplyService({
        outbound: createOutboundService({
          repository: createOutboundRepository(prisma, { enqueueOutboundInTx: async () => {} }),
          client: {
            send: async () => ({ wamid: "w", messageStatus: null, waId: null, userId: null }),
          },
        }),
        mode: createConversationModeService({ repository: modeRepository(), settings: settings() }),
      });

    it("queues the person's message and takes over the conversation", async () => {
      await deliver(
        buildInboundMessage(business, supplier, { type: "text", body: "Hola" }).payload,
      );
      const result = await replyService().reply(
        { waId: "59899000111" },
        { text: "Te atiendo yo" },
        { label: "cli:ana" },
        log,
      );
      expect(
        await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } }),
      ).toMatchObject({
        author: "human",
        purpose: "human",
        status: "pending",
        direction: "outbound",
      });
      expect(result.takeover.state.mode).toBe("human");
      expect(
        await prisma.conversationModeChange.findFirstOrThrow({
          where: { conversationId: result.conversationId },
        }),
      ).toMatchObject({
        reason: "human_reply_panel",
        actorLabel: "cli:ana",
        messageId: result.messageId,
      });
    });

    it("outside the 24 h window: WINDOW_CLOSED and NO takeover", async () => {
      await deliver(
        buildInboundMessage(
          business,
          supplier,
          { type: "text", body: "Hola" },
          { at: new Date(Date.now() - 30 * 3_600_000) },
        ).payload,
      );
      await expect(
        replyService().reply({ waId: "59899000111" }, { text: "Hola" }, { label: "cli:ana" }, log),
      ).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
      expect((await conversationOf("59899000111")).mode).toBe("bot");
    });
  });
});
