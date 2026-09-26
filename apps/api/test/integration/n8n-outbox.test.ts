import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import { buildInboundMessage } from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import { createEnqueueN8nDeliveryInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createDocumentConversionRepository } from "../../src/modules/documents/document-conversion.repository.js";
import { createIntegrationEventRepository } from "../../src/modules/integration/integration-event.repository.js";
import {
  createEmitMessageReadyInTx,
  type EmitMessageReadyInTx,
  type MessageReadyPayload,
} from "../../src/modules/integration/message-ready.js";
import {
  createN8nClient,
  createN8nDeliveryService,
  createN8nWatchdog,
  N8nDeliveryError,
} from "../../src/modules/integration/n8n-delivery.js";
import {
  composeOnStoredInTx,
  createMediaRepository,
  createOnReadyMediaStoredInTx,
} from "../../src/modules/media/media.repository.js";
import { createTranscriptionRepository } from "../../src/modules/transcription/transcription.repository.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Phase 6 M2 against Postgres + real pg-boss: the "message.ready" outbox is written in the
 * transaction of each of the 5 readiness points, and delivered to a FAKE n8n (node:http)
 * that checks the shared secret; retries, permanent failure (alert) and the watchdog.
 */

const log = pino({ level: "silent" });
const SECRET = "test-n8n-webhook-secret-0123456789abcdef";
const PHONE_NUMBER_ID = "100000000000001";
const business = {
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const contact = { waId: "59899000222", bsuid: fakeBsuidFor("59899000222"), name: "Proveedor" };

describe.skipIf(!testDatabaseUrl)(
  "n8n outbox + delivery (Postgres, real pg-boss, fake n8n)",
  () => {
    let prisma: PrismaClient;
    let boss: PgBoss;
    let emit: EmitMessageReadyInTx;
    let fake: {
      server: Server;
      url: string;
      received: { secret: string | undefined; body: MessageReadyPayload }[];
      status: number;
    };

    beforeAll(async () => {
      prisma = createTestPrisma();
      boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
      emit = createEmitMessageReadyInTx(createEnqueueN8nDeliveryInTx(boss));
      const received: typeof fake.received = [];
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          const secret = req.headers["x-smartops-secret"] as string | undefined;
          if (secret !== SECRET) {
            res.writeHead(403).end("forbidden");
            return;
          }
          received.push({ secret, body: JSON.parse(body) as MessageReadyPayload });
          res
            .writeHead(fake.status)
            .end(fake.status < 300 ? '{"message":"Workflow was started"}' : "error");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      fake = {
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/smartops-message-ready`,
        received,
        status: 200,
      };
    });
    afterAll(async () => {
      await new Promise<void>((r) => fake?.server.close(() => r()));
      await boss?.stop({ graceful: false, close: true });
      await prisma?.$disconnect();
    });
    beforeEach(async () => {
      await resetWhatsAppTables(prisma);
      await prisma.$executeRawUnsafe(
        "TRUNCATE TABLE integration_events, alerts, ingestion_runs, transcriptions, document_conversions, media_blobs CASCADE",
      );
      await boss.deleteAllJobs(QUEUES.n8nDelivery);
      fake.received.length = 0;
      fake.status = 200;
    });

    const events = () => prisma.integrationEvent.findMany({ orderBy: { createdAt: "asc" } });
    const jobsFor = async (eventId: string) =>
      boss.findJobs(QUEUES.n8nDelivery, { data: { eventId } });

    /** Webhook → ingest through the real service (the text path emits at ingest). */
    async function ingest(message: Parameters<typeof buildInboundMessage>[2]) {
      const { payload } = buildInboundMessage(business, contact, message);
      const event = await createWhatsAppWebhookRepository(prisma).saveEvent({
        bodySha256: `sha-${Math.random()}`,
        payload,
      });
      if (event.duplicate) throw new Error("duplicate");
      await createWhatsAppIngestService({
        repository: createWhatsAppIngestRepository(prisma, {
          enqueueMediaInTx: async () => {},
          emitMessageReadyInTx: emit,
        }),
        phoneNumberId: PHONE_NUMBER_ID,
      }).processEvent(event.id, log);
      return prisma.message.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    }

    it("text: the event and its delivery job are created in the ingest transaction", async () => {
      const message = await ingest({ type: "text", body: "Tarugo 8mm 150" });
      const [event] = await events();
      expect(event).toMatchObject({
        type: "message.ready",
        messageId: message.id,
        status: "pending",
        dedupeKey: `message.ready:${message.id}`,
      });
      expect(event!.payload).toMatchObject({
        version: 1,
        eventId: event!.id,
        messageId: message.id,
        contactKind: "unknown",
        messageType: "text",
      });
      expect(JSON.stringify(event!.payload)).not.toContain("Tarugo"); // ids only, no content
      expect(await jobsFor(event!.id)).toHaveLength(1);
      // A second emission for the same message is a no-op.
      await prisma.$transaction((tx) => emit(tx, { messageId: message.id }));
      expect(await prisma.integrationEvent.count()).toBe(1);
    });

    it("media: ready only when nothing else has to happen (image now; audio after the transcription; spreadsheet after the conversion; failures too)", async () => {
      const image = await ingest({
        type: "image",
        media: { id: "wm-img", mimeType: "image/jpeg", sha256: "x" },
      });
      const audio = await ingest({
        type: "audio",
        media: { id: "wm-aud", mimeType: "audio/ogg", sha256: "y", voice: true },
      });
      const sheet = await ingest({
        type: "document",
        media: {
          id: "wm-doc",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sha256: "z",
          filename: "l.xlsx",
        },
      });
      const lost = await ingest({
        type: "image",
        media: { id: "wm-lost", mimeType: "image/jpeg", sha256: "w" },
      });
      expect(await prisma.integrationEvent.count()).toBe(0); // all four have pending media

      const media = createMediaRepository(prisma, {
        emitMessageReadyInTx: emit,
        onStoredInTx: composeOnStoredInTx(createOnReadyMediaStoredInTx(emit)),
      });
      const stored = (kind: "image" | "audio" | "document", mimeType: string) => ({
        mimeType,
        sizeBytes: 10,
        sha256: null,
        contentSha256: "c",
        storage: "postgres" as const,
        kind,
      });
      await media.markStored(image.mediaFileId!, stored("image", "image/jpeg"));
      await media.markStored(audio.mediaFileId!, stored("audio", "audio/ogg"));
      await media.markStored(
        sheet.mediaFileId!,
        stored("document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      );
      await media.markFinal(lost.mediaFileId!, "failed", "media_not_found", "404");
      const readyIds = async () => (await events()).map((e) => e.messageId);
      expect(await readyIds()).toEqual([image.id, lost.id]);

      await prisma.transcription.create({ data: { mediaFileId: audio.mediaFileId! } });
      await createTranscriptionRepository(prisma, { emitMessageReadyInTx: emit }).markDone(
        audio.mediaFileId!,
        {
          text: "sube a 150",
          provider: "fake",
          model: "fake",
          language: "es",
          durationSeconds: 3,
          latencyMs: 1,
        },
      );
      await prisma.documentConversion.create({ data: { mediaFileId: sheet.mediaFileId! } });
      await createDocumentConversionRepository(prisma, { emitMessageReadyInTx: emit }).markFailed(
        sheet.mediaFileId!,
        { reason: "zip_bomb", detail: null, durationMs: 1 },
      );
      expect(await readyIds()).toEqual([image.id, lost.id, audio.id, sheet.id]);
    });

    it("the outbox row rolls back with its transaction (never an event without its state, or vice versa)", async () => {
      const message = await ingest({
        type: "image",
        media: { id: "wm-rb", mimeType: "image/jpeg", sha256: "x" },
      });
      const failing = createMediaRepository(prisma, {
        emitMessageReadyInTx: async () => {
          throw new Error("pg-boss down");
        },
        onStoredInTx: async () => {},
      });
      await expect(failing.markFinal(message.mediaFileId!, "failed", "x", "y")).rejects.toThrow();
      expect(
        (await prisma.mediaFile.findUniqueOrThrow({ where: { id: message.mediaFileId! } })).status,
      ).toBe("pending");
      expect(await prisma.integrationEvent.count()).toBe(0);
    });

    function delivery(url = fake.url) {
      const repository = createIntegrationEventRepository(prisma);
      return {
        repository,
        service: createN8nDeliveryService({
          repository,
          client: createN8nClient({ url, secret: SECRET, timeoutMs: 2_000 }),
        }),
      };
    }

    it("delivers to n8n with the secret header; a second delivery of the same event is skipped", async () => {
      const message = await ingest({ type: "text", body: "lista 100" });
      const [event] = await events();
      const { service } = delivery();
      expect(await service.deliver(event!.id, log)).toBe("delivered");
      expect(fake.received).toHaveLength(1);
      expect(fake.received[0]?.body).toMatchObject({ eventId: event!.id, messageId: message.id });
      expect(
        (await prisma.integrationEvent.findUniqueOrThrow({ where: { id: event!.id } })).status,
      ).toBe("delivered");
      expect(await service.deliver(event!.id, log)).toBe("skipped");
      expect(fake.received).toHaveLength(1);
    });

    it("n8n down / 5xx / wrong secret: the attempt is recorded and the job throws (pg-boss retries)", async () => {
      await ingest({ type: "text", body: "lista 100" });
      const [event] = await events();
      fake.status = 503;
      await expect(delivery().service.deliver(event!.id, log)).rejects.toBeInstanceOf(
        N8nDeliveryError,
      );
      await expect(
        delivery("http://127.0.0.1:9/webhook/x").service.deliver(event!.id, log),
      ).rejects.toThrow(/unreachable/);
      const bad = createN8nDeliveryService({
        repository: createIntegrationEventRepository(prisma),
        client: createN8nClient({ url: fake.url, secret: "wrong-secret-0000000000000000000000" }),
      });
      await expect(bad.deliver(event!.id, log)).rejects.toThrow(/403/);
      expect(
        await prisma.integrationEvent.findUniqueOrThrow({ where: { id: event!.id } }),
      ).toMatchObject({
        status: "pending",
        attempts: 3,
      });
    });

    it("retries exhausted → failed + critical integration_error alert (once)", async () => {
      await ingest({ type: "text", body: "lista 100" });
      const [event] = await events();
      const { repository } = delivery();
      expect(await repository.markFailed(event!.id, "retries exhausted")).toBe(true);
      expect(await repository.markFailed(event!.id, "retries exhausted")).toBe(false);
      const alerts = await prisma.alert.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ type: "integration_error", severity: "critical" });
      // n8n:replay puts it back.
      expect(await repository.findFailed({ limit: 10 })).toEqual([event!.id]);
      await repository.requeue([event!.id], { redelivery: false, resetAttempts: true });
      expect(await delivery().service.deliver(event!.id, log)).toBe("delivered");
    });

    it("watchdog: lost pending jobs and delivered-but-never-processed events are sent again (bounded)", async () => {
      const lostJob = await ingest({ type: "text", body: "lista 100" });
      const unprocessed = await ingest({ type: "text", body: "lista 200" });
      const processed = await ingest({ type: "text", body: "lista 300" });
      const byMessage = async (id: string) =>
        prisma.integrationEvent.findFirstOrThrow({ where: { messageId: id } });
      const { service, repository } = delivery();
      await service.deliver((await byMessage(unprocessed.id)).id, log);
      await service.deliver((await byMessage(processed.id)).id, log);
      await prisma.ingestionRun.create({ data: { messageId: processed.id, status: "pending" } });

      const enqueued: string[] = [];
      const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
      const watchdog = createN8nWatchdog({
        repository,
        enqueue: async (id) => {
          enqueued.push(id);
        },
        now: () => later,
      });
      expect(await watchdog.run(log)).toEqual({ stale: 1, redelivered: 1 });
      expect(enqueued.sort()).toEqual(
        [(await byMessage(lostJob.id)).id, (await byMessage(unprocessed.id)).id].sort(),
      );
      expect(await byMessage(unprocessed.id)).toMatchObject({ status: "pending", redeliveries: 1 });

      // Bounded: after 2 redeliveries the watchdog gives up on that event.
      await service.deliver((await byMessage(unprocessed.id)).id, log);
      await watchdog.run(log);
      await service.deliver((await byMessage(unprocessed.id)).id, log);
      enqueued.length = 0;
      await watchdog.run(log);
      expect(enqueued).not.toContain((await byMessage(unprocessed.id)).id);
    });

    it("outbound messages never produce events", async () => {
      const message = await ingest({ type: "text", body: "lista 100" });
      const outbound = await prisma.message.create({
        data: {
          conversationId: message.conversationId,
          direction: "outbound",
          type: "text",
          author: "bot",
          purpose: "auto_reply",
          text: "ok",
        },
      });
      const result = await prisma.$transaction((tx) => emit(tx, { messageId: outbound.id }));
      expect(result).toEqual({ created: false, eventId: null });
    });
  },
);
