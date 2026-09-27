import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/ai.client.js";
import { createLlmProvider } from "../../src/ai/ai.factory.js";
import { loadPrompt } from "../../src/ai/prompts.js";
import { createAiUsageRepository } from "../../src/ai/usage.repository.js";
import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/common/db.js";
import { parseEnv } from "../../src/config/env.js";
import {
  createEnqueueN8nDeliveryInTx,
  createEnqueueOutboundInTx,
  createScheduleDigestInTx,
  startBoss,
} from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { FAKE_RESPONDERS } from "../../src/modules/extraction/fake-responders.js";
import { createIngestionRepository } from "../../src/modules/extraction/ingestion.repository.js";
import { createIngestionService } from "../../src/modules/extraction/ingestion.service.js";
import { createIntegrationEventRepository } from "../../src/modules/integration/integration-event.repository.js";
import {
  createEmitMessageReadyInTx,
  messageReadyPayloadSchema,
  type MessageReadyPayload,
} from "../../src/modules/integration/message-ready.js";
import {
  createN8nClient,
  createN8nDeliveryService,
} from "../../src/modules/integration/n8n-delivery.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import {
  composeOnStoredInTx,
  createMediaRepository,
  createOnReadyMediaStoredInTx,
} from "../../src/modules/media/media.repository.js";
import { createOutboundRepository } from "../../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../../src/modules/messaging/outbound.service.js";
import { createNotificationRepository } from "../../src/modules/notifications/notification.repository.js";
import { createNotificationService } from "../../src/modules/notifications/notification.service.js";
import { createSupplierAckService } from "../../src/modules/notifications/supplier-ack.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import type { WhatsAppSendClient } from "../../src/modules/whatsapp/whatsapp-send.client.js";
import {
  createFakeWebhookQueue,
  createInMemoryWebhookRepository,
  healthyDb,
  TEST_ENV_SOURCE,
  TEST_INTERNAL_API_KEY,
  stubAuthService,
  stubAdminDeps,
} from "../helpers/build-app.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Backend ↔ n8n CONTRACT (phase 6 M3). A fake n8n "orchestrator" receives the outbox event
 * (checking the shared secret), answers 200 at once and then does over HTTP exactly what
 * the receiver → processor → notifier workflows do. Postgres + golden outputs, $0.
 * The real workflows (M4) must keep this contract; their JSON is checked statically too.
 */

const log = pino({ level: "silent" });
const SECRET = "contract-n8n-webhook-secret-0123456789ab";
const FIXTURES = new URL("../fixtures/extraction/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));

type Step = { path: string; status: number; body: Record<string, unknown> };

describe.skipIf(!testDatabaseUrl)("contract: backend ↔ fake n8n orchestrator (HTTP)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let api: Server;
  let apiUrl: string;
  let n8n: Server;
  let n8nUrl: string;
  let executions: Promise<Step[]>[] = [];
  const payloads: boolean[] = [];

  /** What the three workflows do, as plain HTTP calls with the Header Auth credential. */
  async function orchestrate(event: MessageReadyPayload): Promise<Step[]> {
    const steps: Step[] = [];
    const call = async (method: "GET" | "POST", path: string, body?: object) => {
      const res = await fetch(`${apiUrl}/api/v1/internal${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-internal-api-key": TEST_INTERNAL_API_KEY,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await res.json()) as Record<string, unknown>;
      steps.push({ path, status: res.status, body: json });
      return json;
    };
    // Receiver
    const classified = await call("POST", "/classify", { messageId: event.messageId });
    const cls = classified.classification as string | null;
    // Same mapping as the real receiver (Ruta): customer_query → customer_query, internal_order → order.
    const notifyKind = { customer_query: "customer_query", internal_order: "order" }[cls ?? ""];
    if (notifyKind) {
      await call("POST", "/notifications", { kind: notifyKind, messageId: event.messageId });
      return steps;
    }
    if (!(cls === null || cls === "price_list_full" || cls === "price_update_partial"))
      return steps;
    // Processor (full vs partial comes from the EXTRACTION, never from the classifier)
    const runId = classified.runId as string;
    const extracted = await call("POST", "/extract", { runId });
    if (extracted.status === "extracted") await call("POST", "/catalog/ingest", { runId });
    await call("GET", `/runs/${runId}`);
    // Notifier
    await call("POST", "/notifications", { kind: "run", runId });
    await call("POST", "/messages/ack", { runId });
    return steps;
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
    const env = parseEnv({ ...TEST_ENV_SOURCE });
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const ai = createAiClient({
      provider: createLlmProvider(env, FAKE_RESPONDERS),
      usage: createAiUsageRepository(prisma),
      limits: { totalUsd: 4, dailyUsd: 0.5, dailyExtractionsPerContact: 20, runUsd: 0.3 },
    });
    const notificationRepository = createNotificationRepository(prisma, {
      scheduleDigestInTx: createScheduleDigestInTx(boss),
    });
    const neverCalled: WhatsAppSendClient = {
      send: async () => {
        throw new Error("no Meta in contract tests");
      },
    } as never;
    const outbound = createOutboundService({
      repository: createOutboundRepository(prisma, {
        enqueueOutboundInTx: createEnqueueOutboundInTx(boss),
      }),
      client: neverCalled,
    });
    const app = createApp({
      env,
      logger: log,
      healthRepository: healthyDb,
      whatsappWebhookRepository: createInMemoryWebhookRepository(),
      webhookQueue: createFakeWebhookQueue(),
      auth: stubAuthService,
      admin: stubAdminDeps,
      internal: {
        ingestion: createIngestionService({
          repository: createIngestionRepository(prisma),
          storage: createPostgresMediaStorage(prisma),
          ai,
          prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
          models: {
            classifier: env.AI_CLASSIFIER_MODEL,
            extractor: env.AI_EXTRACTOR_MODEL,
            cacheSystemPrompts: true,
          },
        }),
        catalog: createCatalogIngestService({
          repository: createCatalogRepository(prisma),
          settings,
        }),
        settings,
        notifications: createNotificationService({ repository: notificationRepository, settings }),
        supplierAck: createSupplierAckService({
          repository: notificationRepository,
          settings,
          outbound,
        }),
      },
    });
    api = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => api.once("listening", () => r()));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    n8n = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        if (req.headers["x-smartops-secret"] !== SECRET) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200).end('{"message":"Workflow was started"}'); // Respond: Immediately
        // Phase 10 M4: every REAL payload matches the contract schema (strict: no extra field).
        payloads.push(messageReadyPayloadSchema.safeParse(JSON.parse(body)).success);
        executions.push(orchestrate(JSON.parse(body) as MessageReadyPayload));
      });
    });
    await new Promise<void>((r) => n8n.listen(0, "127.0.0.1", () => r()));
    n8nUrl = `http://127.0.0.1:${(n8n.address() as AddressInfo).port}/webhook/smartops-message-ready`;
  });
  afterAll(async () => {
    expect(payloads.length, "real message.ready payloads seen").toBeGreaterThan(0);
    expect(payloads.every(Boolean), "message.ready payloads match the contract").toBe(true);
    await new Promise<void>((r) => n8n?.close(() => r()));
    await new Promise<void>((r) => api?.close(() => r()));
    await boss?.stop({ graceful: false, close: true });
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE integration_events, notification_items, notification_digests, review_items, alerts, price_changes, ai_usages, ingestion_runs, products, supplier_sheet_formats, suppliers, settings, media_blobs, document_conversions CASCADE",
    );
    await boss.deleteAllJobs(QUEUES.n8nDelivery);
    await prisma.setting.create({ data: { key: "bot.supplierAck", value: true } });
    executions = [];
  });

  const emit = () => createEmitMessageReadyInTx(createEnqueueN8nDeliveryInTx(boss));
  const deliver = async () => {
    const repository = createIntegrationEventRepository(prisma);
    const service = createN8nDeliveryService({
      repository,
      client: createN8nClient({ url: n8nUrl, secret: SECRET }),
    });
    const pending = await prisma.integrationEvent.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    for (const event of pending) await service.deliver(event.id, log);
    const done = await Promise.all(executions);
    executions = [];
    return done;
  };

  let clock = Date.parse("2026-10-01T12:00:00Z");
  async function contactAndConversation(kind: "unknown" | "customer" = "unknown") {
    const contact = await prisma.contact.create({
      data: { waId: `59899${Math.floor(Math.random() * 1e6)}`, name: "Juan", kind },
    });
    return prisma.conversation.create({
      data: { contactId: contact.id, lastInboundAt: new Date() },
    });
  }

  /** A media message that becomes ready through the real media-stored hook (outbox). */
  async function mediaMessage(
    conversationId: string,
    bytes: Uint8Array,
    mimeType: string,
    kind: "image" | "document",
  ) {
    clock += 3_600_000;
    const media = await prisma.mediaFile.create({
      data: { waMediaId: `wm-${clock}`, mimeType, status: "pending" },
    });
    const message = await prisma.message.create({
      data: {
        conversationId,
        direction: "inbound",
        type: kind,
        author: "contact",
        mediaFileId: media.id,
        waTimestamp: new Date(clock),
      },
    });
    await createPostgresMediaStorage(prisma).put(media.id, bytes);
    await createMediaRepository(prisma, {
      onStoredInTx: composeOnStoredInTx(createOnReadyMediaStoredInTx(emit())),
    }).markStored(media.id, {
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: null,
      contentSha256: "x",
      storage: "postgres",
      kind,
    });
    return message;
  }

  it("PDF then photo: the contract carries the list to the catalog and notifies only what is actionable", async () => {
    const conversation = await contactAndConversation();
    await mediaMessage(conversation.id, read("lista-prueba.pdf"), "application/pdf", "document");
    const [september] = await deliver();
    expect(september!.map((s) => [s.path.replace(/[0-9a-f-]{36}/, ":id"), s.status])).toEqual([
      ["/classify", 200],
      ["/extract", 200],
      ["/catalog/ingest", 200],
      ["/runs/:id", 200],
      ["/notifications", 200],
      ["/messages/ack", 200],
    ]);
    expect(september!.find((s) => s.path === "/catalog/ingest")?.body).toMatchObject({
      counts: { created: 7 },
    });
    // First list: only new products → nothing actionable → no notification (panel has the run).
    expect(september!.find((s) => s.path === "/notifications")?.body).toEqual({
      notified: false,
      reason: "nothing_actionable",
      items: 0,
    });
    expect(september!.at(-1)?.body).toMatchObject({ sent: true }); // ack queued (window open)

    await mediaMessage(conversation.id, read("lista-precios-foto.jpg"), "image/jpeg", "image");
    const [october] = await deliver();
    expect(october!.find((s) => s.path === "/catalog/ingest")?.body).toMatchObject({
      counts: { updated: 5, review: 1 },
    });
    expect(october!.find((s) => s.path === "/notifications")?.body).toEqual({
      notified: true,
      items: 1,
    });
    const [item] = await prisma.notificationItem.findMany();
    expect(item).toMatchObject({ recipient: "panel", category: "run_summary" });
    expect(item!.title).toBe(
      "Distribuidora Demo S.A.: 5 aumentos (2 mayores al 10 %), 1 revisión pendiente",
    );
  });

  it("at-least-once: the same event delivered twice produces one run, one catalog change set, one notification", async () => {
    const conversation = await contactAndConversation();
    await mediaMessage(conversation.id, read("lista-prueba.pdf"), "application/pdf", "document");
    await deliver();
    await mediaMessage(conversation.id, read("lista-precios-foto.jpg"), "image/jpeg", "image");
    await deliver();
    const photoEvent = await prisma.integrationEvent.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    await createIntegrationEventRepository(prisma).requeue([photoEvent.id], {
      redelivery: true,
      resetAttempts: true,
    });
    await deliver();
    expect(await prisma.ingestionRun.count()).toBe(2);
    expect(await prisma.priceChange.count({ where: { source: "auto" } })).toBe(7 + 5);
    expect(await prisma.notificationItem.count()).toBe(1);
    expect(await prisma.message.count({ where: { direction: "outbound" } })).toBe(2); // one ack per run
  });

  it("customer messages: no LLM, no extraction, a customer_query notification", async () => {
    const conversation = await contactAndConversation("customer");
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "¿Tienen candados de 40mm?",
      },
    });
    await prisma.$transaction((tx) => emit()(tx, { messageId: message.id }));
    const [steps] = await deliver();
    expect(steps!.map((s) => s.path)).toEqual(["/classify", "/notifications"]);
    expect(steps![0]!.body).toMatchObject({
      classification: "customer_query",
      prefilterRule: "customer_contact",
    });
    expect(await prisma.aiUsage.count()).toBe(0);
    expect(await prisma.notificationItem.findFirstOrThrow()).toMatchObject({
      category: "customer_query",
    });
  });

  it("a customer's ORDER: no LLM, an order notification (phase 8 — never lost)", async () => {
    const conversation = await contactAndConversation("customer");
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "Perfecto, necesito 3 macetas",
      },
    });
    await prisma.$transaction((tx) => emit()(tx, { messageId: message.id }));
    const [steps] = await deliver();
    expect(steps!.map((s) => s.path)).toEqual(["/classify", "/notifications"]);
    expect(steps![0]!.body).toMatchObject({
      classification: "internal_order",
      prefilterRule: "customer_contact",
    });
    expect(await prisma.aiUsage.count()).toBe(0);
    const items = await prisma.notificationItem.findMany();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.category === "order")).toBe(true);
    expect(items[0]!.title).toMatch(/^Pedido de /);
  });
});
