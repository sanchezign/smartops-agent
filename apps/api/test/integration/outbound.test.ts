import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromPrisma, type PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeGraph,
  type FakeGraph,
  type FakeGraphOptions,
} from "../../scripts/simulator/fake-graph.js";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import { createMediaStore } from "../../scripts/simulator/media-store.js";
import { buildInboundMessage, type SimContact } from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import type { AppError } from "../../src/common/errors/app-error.js";
import { createEnqueueOutboundInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { registerWhatsAppOutboundWorkers } from "../../src/jobs/whatsapp-outbound.job.js";
import {
  createOutboundRepository,
  type EnqueueOutboundInTx,
} from "../../src/modules/messaging/outbound.repository.js";
import {
  createOutboundService,
  type OutboundService,
} from "../../src/modules/messaging/outbound.service.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import {
  createWhatsAppSendClient,
  type WhatsAppSendClient,
} from "../../src/modules/whatsapp/whatsapp-send.client.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Milestone 4 end to end, without Meta: outbound service → pg-boss (key_strict_fifo)
 * → production send client → fake Graph API → signed status webhooks → ingestion
 * (milestone 2) → Message sent/delivered/read. Real Postgres and real pg-boss.
 */

const TOKEN = "EAAfake-token-for-outbound-tests";
const PHONE_NUMBER_ID = "100000000000001";
const business = {
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const log = pino({ level: "silent" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDatabaseUrl)(
  "outbound messages against Postgres + pg-boss + fake Graph",
  () => {
    let prisma: PrismaClient;
    let boss: PgBoss;
    let receiver: Server;
    let receiverUrl: string;
    let fake: FakeGraph | undefined;
    let graphUrl: string;
    let workersRegistered = false;

    const webhookRepository = () => createWhatsAppWebhookRepository(prisma);
    const ingest = () =>
      createWhatsAppIngestService({
        repository: createWhatsAppIngestRepository(prisma, { enqueueMediaInTx: async () => {} }),
        phoneNumberId: PHONE_NUMBER_ID,
      });

    /** Stored + processed exactly like the webhook → worker path. */
    async function deliverWebhook(payload: unknown): Promise<void> {
      const saved = await webhookRepository().saveEvent({
        bodySha256: `${Date.now()}${Math.random()}`.replace(/\D/g, "").padEnd(64, "0").slice(0, 64),
        payload,
      });
      if (!saved.duplicate) await ingest().processEvent(saved.id, log);
    }

    function outboundService(client?: WhatsAppSendClient, enqueue?: EnqueueOutboundInTx) {
      return createOutboundService({
        repository: createOutboundRepository(prisma, {
          enqueueOutboundInTx: enqueue ?? createEnqueueOutboundInTx(boss),
        }),
        client:
          client ??
          createWhatsAppSendClient({
            graph: { baseUrl: graphUrl, version: "v26.0", accessToken: TOKEN, timeoutMs: 5_000 },
            phoneNumberId: PHONE_NUMBER_ID,
          }),
      });
    }

    async function startFake(overrides: Partial<FakeGraphOptions> = {}) {
      fake = createFakeGraph({
        business,
        accessToken: TOKEN,
        appSecret: "unused-signature-secret-000000",
        webhookUrl: receiverUrl,
        mediaStore: createMediaStore(`${process.cwd()}/.sim/test-outbound`),
        logger: log,
        statusDelayMs: 20,
        ...overrides,
      });
      graphUrl = await fake.listen(0);
    }

    async function contactWrites(contact: SimContact, text = "Hola"): Promise<void> {
      await deliverWebhook(
        buildInboundMessage(business, contact, { type: "text", body: text }).payload,
      );
    }

    async function waitForStatus(messageId: string, status: string, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
        if (message.status === status) return message;
        if (Date.now() > deadline) {
          throw new Error(`message ${messageId} is ${message.status}, expected ${status}`);
        }
        await sleep(50);
      }
    }

    const supplier: SimContact = {
      waId: "59899000111",
      bsuid: fakeBsuidFor("59899000111"),
      name: "Proveedor",
    };

    beforeAll(async () => {
      prisma = createTestPrisma();
      boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
      await boss.deleteAllJobs(QUEUES.whatsappOutbound);
      await boss.deleteAllJobs(QUEUES.whatsappOutboundDlq);
      // Plays the API webhook endpoint: every status webhook goes through real ingestion.
      receiver = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          deliverWebhook(JSON.parse(Buffer.concat(chunks).toString("utf8")))
            .catch(() => {})
            .finally(() => res.writeHead(200).end("OK"));
        });
      });
      await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
    });

    afterAll(async () => {
      await new Promise<void>((r) => receiver.close(() => r()));
      await boss?.stop({ graceful: false, close: true });
      await prisma?.$disconnect();
    });

    beforeEach(async () => {
      await resetWhatsAppTables(prisma);
    });

    afterEach(async () => {
      if (workersRegistered) {
        await boss.offWork(QUEUES.whatsappOutbound);
        await boss.offWork(QUEUES.whatsappOutboundDlq);
        workersRegistered = false;
      }
      await fake?.close();
      fake = undefined;
    });

    it("text inside the window: queued → sent → delivered → read, via real status webhooks", async () => {
      await startFake();
      await contactWrites(supplier);
      const contact = await prisma.contact.findFirstOrThrow();
      expect(contact).toMatchObject({ optInSource: "inbound" }); // implicit opt-in (ADR-009)

      const service = outboundService();
      const { messageId, conversationId } = await service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Recibimos tu lista" },
          author: "bot",
        },
        log,
      );
      const jobs = await boss.findJobs(QUEUES.whatsappOutbound, { data: { messageId } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.singletonKey).toBe(conversationId);

      expect(await service.processOutbound(messageId, log, { finalAttempt: false })).toEqual({
        outcome: "accepted",
      });
      const read = await waitForStatus(messageId, "read");
      expect(read.waMessageId).toMatch(/^wamid\./);
      expect(await prisma.messageStatusEvent.count({ where: { messageId } })).toBe(3);
      expect(fake?.sent[0]?.body).toMatchObject({
        to: "59899000111",
        text: { body: "Recibimos tu lista" },
      });
    });

    it("refuses text outside the window (WINDOW_CLOSED) and stores nothing", async () => {
      await startFake();
      await contactWrites(supplier);
      await prisma.conversation.updateMany({
        data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      const err = await outboundService()
        .send(
          {
            recipient: { waId: "59899000111" },
            content: { kind: "text", body: "Hola" },
            author: "bot",
          },
          log,
        )
        .catch((e: unknown) => e);
      expect((err as AppError).code).toBe("WINDOW_CLOSED");
      expect(await prisma.message.count({ where: { direction: "outbound" } })).toBe(0);
    });

    it("templates need opt-in: OPT_IN_REQUIRED, then a manual opt-in allows it", async () => {
      await startFake();
      const service = outboundService();
      const template = { kind: "template" as const, name: "hello_world", languageCode: "en_US" };
      const err = await service
        .send({ recipient: { waId: "59899000222" }, content: template, author: "bot" }, log)
        .catch((e: unknown) => e);
      expect((err as AppError).code).toBe("OPT_IN_REQUIRED");
      expect(await prisma.contact.count()).toBe(0);

      await service.recordManualOptIn({ waId: "59899000222" }, log);
      expect(await prisma.contact.findFirstOrThrow()).toMatchObject({ optInSource: "manual" });

      const { messageId } = await service.send(
        { recipient: { waId: "59899000222" }, content: template, author: "bot" },
        log,
      );
      await service.processOutbound(messageId, log, { finalAttempt: false });
      await waitForStatus(messageId, "read");
    });

    it("a template unknown to Meta fails with 132001", async () => {
      await startFake({ templates: ["hello_world"] });
      await contactWrites(supplier);
      const service = outboundService();
      const { messageId } = await service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "template", name: "price_alert", languageCode: "es" },
          author: "bot",
        },
        log,
      );
      expect(await service.processOutbound(messageId, log, { finalAttempt: false })).toEqual({
        outcome: "failed",
        reason: "132001",
      });
      expect(await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({
        status: "failed",
        errorCode: "132001",
      });
    });

    it("Meta rejecting a text outside its window (131047 status webhook) marks it failed", async () => {
      await startFake({ outsideWindow: true });
      await contactWrites(supplier);
      const service = outboundService();
      const { messageId } = await service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      );
      await service.processOutbound(messageId, log, { finalAttempt: false });
      expect(await waitForStatus(messageId, "failed")).toMatchObject({ errorCode: "131047" });
    });

    it("rate limits (429) are retried, and the last attempt settles as failed", async () => {
      await startFake({ faults: { send: 429 } });
      await contactWrites(supplier);
      const service = outboundService();
      const { messageId } = await service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      );
      await expect(
        service.processOutbound(messageId, log, { finalAttempt: false }),
      ).rejects.toThrow();
      expect((await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).status).toBe(
        "pending",
      );
      expect((await service.processOutbound(messageId, log, { finalAttempt: true })).reason).toBe(
        "130429",
      );
    });

    it("BSUID-only contacts are addressed with `recipient`", async () => {
      await startFake();
      const bsuidOnly: SimContact = {
        waId: null,
        bsuid: "UY.9Z8Y7X6W5V4U3T2S1R0Q",
        name: "Username",
      };
      await contactWrites(bsuidOnly);
      const service = outboundService();
      const { messageId } = await service.send(
        {
          recipient: { bsuid: "UY.9Z8Y7X6W5V4U3T2S1R0Q" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      );
      await service.processOutbound(messageId, log, { finalAttempt: false });
      expect(fake?.sent[0]?.body).toMatchObject({ recipient: "UY.9Z8Y7X6W5V4U3T2S1R0Q" });
      expect(fake?.sent[0]?.body).not.toHaveProperty("to");
      await waitForStatus(messageId, "read");
    });

    it("applies statuses that arrived BEFORE the wamid was stored (backfill)", async () => {
      await contactWrites(supplier);
      const repository = createOutboundRepository(prisma, { enqueueOutboundInTx: async () => {} });
      const contact = await prisma.contact.findFirstOrThrow();
      const { messageId } = await repository.createOutbound({
        contactId: contact.id,
        type: "text",
        text: "Hola",
        author: "bot",
        request: {},
      });
      // The webhook wins the race: statuses recorded while the message has no wamid yet.
      const ingestRepository = createWhatsAppIngestRepository(prisma, {
        enqueueMediaInTx: async () => {},
      });
      for (const status of ["sent", "delivered"]) {
        await ingestRepository.recordStatus({
          status: {
            waMessageId: "wamid.EARLY",
            status,
            timestamp: new Date(),
            recipientWaId: "59899000111",
            recipientUserId: null,
            errors: [],
            pricing: null,
          },
          webhookEventId: (await prisma.webhookEvent.findFirstOrThrow()).id,
        });
      }

      expect(
        await repository.markAccepted(messageId, {
          wamid: "wamid.EARLY",
          response: {},
          at: new Date(),
        }),
      ).toEqual({ appliedStatuses: 2 });
      expect((await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).status).toBe(
        "delivered",
      );
      expect(await prisma.messageStatusEvent.count({ where: { messageId } })).toBe(2);
    });

    it("the same idempotency key sent concurrently creates one message", async () => {
      await startFake();
      await contactWrites(supplier);
      const service = outboundService();
      const send = () =>
        service.send(
          {
            recipient: { waId: "59899000111" },
            content: { kind: "text", body: "Alerta" },
            author: "bot",
            idempotencyKey: "n8n-exec-77:price-alert",
          },
          log,
        );
      const results = await Promise.all([send(), send(), send()]);
      expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
      expect(await prisma.message.count({ where: { direction: "outbound" } })).toBe(1);
    });

    describe("with real pg-boss workers", () => {
      async function registerWorkers(service: OutboundService, concurrency: number) {
        await registerWhatsAppOutboundWorkers(boss, {
          service,
          repository: createOutboundRepository(prisma, { enqueueOutboundInTx: async () => {} }),
          logger: log,
          concurrency,
        });
        workersRegistered = true;
      }

      it("keeps order per conversation while sending to different contacts in parallel", async () => {
        await startFake();
        const alice: SimContact = { waId: "59899000301", bsuid: null, name: "A" };
        const bob: SimContact = { waId: "59899000302", bsuid: null, name: "B" };
        await contactWrites(alice);
        await contactWrites(bob);

        // Instrumented client: slow sends, tracks concurrency per recipient.
        const real = createWhatsAppSendClient({
          graph: { baseUrl: graphUrl, version: "v26.0", accessToken: TOKEN, timeoutMs: 5_000 },
          phoneNumberId: PHONE_NUMBER_ID,
        });
        const inFlight = new Map<string, number>();
        let maxPerRecipient = 0;
        let maxTotal = 0;
        const client: WhatsAppSendClient = {
          async send(payload) {
            const to = String(payload.to);
            inFlight.set(to, (inFlight.get(to) ?? 0) + 1);
            maxPerRecipient = Math.max(maxPerRecipient, inFlight.get(to) ?? 0);
            maxTotal = Math.max(
              maxTotal,
              [...inFlight.values()].reduce((a, b) => a + b, 0),
            );
            try {
              await sleep(150);
              return await real.send(payload);
            } finally {
              inFlight.set(to, (inFlight.get(to) ?? 1) - 1);
            }
          },
        };
        const service = outboundService(client);

        const ids: Record<string, string[]> = { "59899000301": [], "59899000302": [] };
        for (let i = 1; i <= 3; i += 1) {
          for (const to of ["59899000301", "59899000302"]) {
            const { messageId } = await service.send(
              {
                recipient: { waId: to },
                content: { kind: "text", body: `msg ${i}` },
                author: "bot",
              },
              log,
            );
            ids[to]?.push(messageId);
          }
        }
        await registerWorkers(service, 4);

        for (const id of [...(ids["59899000301"] ?? []), ...(ids["59899000302"] ?? [])]) {
          await waitForStatus(id, "read", 20_000);
        }
        for (const to of ["59899000301", "59899000302"]) {
          const bodies = (fake?.sent ?? [])
            .filter((m) => m.to === to)
            .map((m) => (m.body.text as { body: string }).body);
          expect(bodies).toEqual(["msg 1", "msg 2", "msg 3"]);
        }
        expect(maxPerRecipient).toBe(1); // never two sends to the same conversation at once
        expect(maxTotal).toBeGreaterThanOrEqual(2); // but different conversations in parallel
      }, 30_000);

      it("a dead-lettered job is removed so the conversation is not blocked forever", async () => {
        await startFake();
        await contactWrites(supplier);
        const conversation = await prisma.conversation.findFirstOrThrow();

        // Message 1: its job allows no retries, then fails → failed state + DLQ copy.
        const noRetry: EnqueueOutboundInTx = async (tx, { messageId, conversationId }) => {
          await boss.send(
            QUEUES.whatsappOutbound,
            { messageId },
            { db: fromPrisma(tx), singletonKey: conversationId, retryLimit: 0 },
          );
        };
        const first = await outboundService(undefined, noRetry).send(
          {
            recipient: { waId: "59899000111" },
            content: { kind: "text", body: "uno" },
            author: "bot",
          },
          log,
        );
        const [job] = await boss.fetch(QUEUES.whatsappOutbound);
        expect(job?.data).toEqual({ messageId: first.messageId });
        await boss.fail(QUEUES.whatsappOutbound, job?.id ?? "");

        // Message 2 to the same conversation is held back by the failed job.
        const service = outboundService();
        const second = await service.send(
          {
            recipient: { waId: "59899000111" },
            content: { kind: "text", body: "dos" },
            author: "bot",
          },
          log,
        );
        expect(await boss.getBlockedKeys(QUEUES.whatsappOutbound)).toContain(conversation.id);

        // The DLQ worker marks message 1 failed and deletes its job → message 2 goes out.
        await registerWorkers(service, 2);
        expect(await waitForStatus(first.messageId, "failed", 20_000)).toMatchObject({
          errorCode: "retries_exhausted",
        });
        await waitForStatus(second.messageId, "read", 20_000);
        expect(await boss.getBlockedKeys(QUEUES.whatsappOutbound)).not.toContain(conversation.id);
      }, 40_000);
    });
  },
);
