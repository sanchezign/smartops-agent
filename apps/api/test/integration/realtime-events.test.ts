import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import type { PanelEvent } from "../../src/modules/events/panel-events.js";
import { createPgListener, type PgListener } from "../../src/modules/events/pg-listener.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Database triggers (migration realtime_events) → the ONE LISTEN connection (phase 9 M4,
 * ADR-020): committed changes are announced with ids only; rolled-back ones never are; a bulk
 * catalog write is one event.
 */

describe.skipIf(!testDatabaseUrl)("realtime events (Postgres)", () => {
  let prisma: PrismaClient;
  let listener: PgListener;
  let received: PanelEvent[];

  beforeAll(async () => {
    prisma = createTestPrisma();
    received = [];
    listener = createPgListener({
      connectionString: testDatabaseUrl!,
      onEvent: (e) => received.push(e),
      onReconnect: () => undefined,
      logger: pino({ level: "silent" }),
    });
    await listener.start();
  });
  afterAll(async () => {
    await listener?.stop();
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe("TRUNCATE TABLE suppliers CASCADE");
    await settle();
    received = [];
  });
  afterEach(() => {
    received = [];
  });

  /** NOTIFY is asynchronous: wait until nothing new arrives for a moment. */
  async function settle(ms = 150) {
    let last = -1;
    while (last !== received.length) {
      last = received.length;
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  async function conversation() {
    const contact = await prisma.contact.create({ data: { waId: "59899000123" } });
    return prisma.conversation.create({ data: { contactId: contact.id } });
  }

  it("a new message and its status change are announced with ids only (no text)", async () => {
    const c = await conversation();
    const m = await prisma.message.create({
      data: {
        conversationId: c.id,
        direction: "outbound",
        type: "text",
        author: "human",
        purpose: "human",
        text: "texto privado del cliente",
        status: "pending",
      },
    });
    await prisma.message.update({ where: { id: m.id }, data: { status: "sent" } });
    await prisma.message.update({ where: { id: m.id }, data: { statusAt: new Date() } }); // not announced
    await settle();
    expect(received).toEqual([
      { type: "message.created", conversationId: c.id, messageId: m.id, direction: "outbound" },
      { type: "message.updated", conversationId: c.id, messageId: m.id, status: "sent" },
    ]);
    expect(JSON.stringify(received)).not.toContain("privado");
  });

  it("mode changes and opt-outs are announced; a rolled-back change is not", async () => {
    const c = await conversation();
    await prisma.conversation.update({ where: { id: c.id }, data: { mode: "human" } });
    await prisma.contact.update({
      where: { id: c.contactId },
      data: { optOutAt: new Date(), optOutSource: "keyword" },
    });
    await prisma
      .$transaction(async (tx) => {
        await tx.conversation.update({ where: { id: c.id }, data: { mode: "bot" } });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await settle();
    expect(received).toEqual([
      { type: "conversation.updated", conversationId: c.id, mode: "human" },
      { type: "contact.updated", contactId: c.contactId },
    ]);
  });

  it("a bulk catalog write is ONE event with the supplier ids", async () => {
    const supplier = await prisma.supplier.create({
      data: { name: "Norte", normalizedName: "norte" },
    });
    await settle();
    received = [];
    await prisma.product.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({
        supplierId: supplier.id,
        name: `Producto ${i}`,
        normalizedName: `producto ${i}`,
        price: new Prisma.Decimal(i + 1),
        currency: "UYU",
      })),
    });
    await prisma.product.updateMany({
      where: { supplierId: supplier.id },
      data: { available: false },
    });
    await settle();
    expect(received).toEqual([
      { type: "catalog.changed", supplierIds: [supplier.id] },
      { type: "catalog.changed", supplierIds: [supplier.id] },
    ]);
  });

  // Phase 10 M3: every trigger of the realtime_events migration, not just the chat ones.
  it("media status, review items, ingestion runs and alerts are announced (ids + status only)", async () => {
    const c = await conversation();
    const media = await prisma.mediaFile.create({
      data: { waMediaId: "media-realtime-1", mimeType: "image/jpeg" },
    });
    const m = await prisma.message.create({
      data: {
        conversationId: c.id,
        direction: "inbound",
        type: "image",
        author: "contact",
        mediaFileId: media.id,
      },
    });
    const run = await prisma.ingestionRun.create({ data: { messageId: m.id } });
    const review = await prisma.reviewItem.create({
      data: {
        ingestionRunId: run.id,
        scope: "line",
        kind: "uncertain_value",
        dedupeKey: "line:1",
        proposal: { secret: "texto de la lista" },
      },
    });
    const alert = await prisma.alert.create({
      data: { type: "manual_attention", title: "Mirar a mano" },
    });
    await settle();
    received = [];

    await prisma.mediaFile.update({ where: { id: media.id }, data: { status: "stored" } });
    await prisma.mediaFile.update({ where: { id: media.id }, data: { attempts: 2 } }); // silent
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "classified" } });
    await prisma.reviewItem.update({ where: { id: review.id }, data: { status: "approved" } });
    await prisma.alert.update({ where: { id: alert.id }, data: { status: "acknowledged" } });
    await settle();

    expect(received).toEqual([
      { type: "message.updated", conversationId: c.id, messageId: m.id, mediaStatus: "stored" },
      { type: "run.changed", runId: run.id, status: "classified" },
      { type: "review.changed", reviewId: review.id, status: "approved" },
      { type: "alert.changed", alertId: alert.id, severity: alert.severity },
    ]);
    expect(JSON.stringify(received)).not.toMatch(/texto de la lista|Mirar a mano/);
  });

  it("inserts of runs, reviews and alerts are announced too", async () => {
    const c = await conversation();
    const m = await prisma.message.create({
      data: { conversationId: c.id, direction: "inbound", type: "text", author: "contact" },
    });
    await settle();
    received = [];
    const run = await prisma.ingestionRun.create({ data: { messageId: m.id } });
    const review = await prisma.reviewItem.create({
      data: {
        ingestionRunId: run.id,
        scope: "run",
        kind: "suspicious_instructions",
        dedupeKey: "run:1",
        proposal: {},
      },
    });
    const alert = await prisma.alert.create({ data: { type: "low_stock", title: "Poco stock" } });
    await settle();
    expect(received).toEqual([
      { type: "run.changed", runId: run.id, status: "pending" },
      { type: "review.changed", reviewId: review.id, status: "pending" },
      { type: "alert.changed", alertId: alert.id, severity: alert.severity },
    ]);
  });

  it("the LISTEN connection killed by the server comes back, resyncs and keeps delivering", async () => {
    const reconnects: number[] = [];
    const events: PanelEvent[] = [];
    const own = createPgListener({
      connectionString: testDatabaseUrl!,
      onEvent: (e) => events.push(e),
      onReconnect: () => reconnects.push(Date.now()),
      logger: pino({ level: "silent" }),
      backoffMs: () => 100,
    });
    await own.start();
    try {
      // Kill ONLY the listener of this test (the suite's own listener stays up): the newest
      // backend of this application that is LISTENing IN THE TEST DATABASE (pg_stat_activity is
      // cluster-wide: a developer's API on another database must never be touched).
      const [victim] = await prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = 'smartops-api-events' AND query ILIKE 'LISTEN%'
         ORDER BY backend_start DESC LIMIT 1`;
      expect(victim).toBeDefined();
      await prisma.$queryRaw`SELECT pg_terminate_backend(${victim!.pid}::int)`;

      await expect.poll(() => reconnects.length, { timeout: 5_000 }).toBe(1);
      expect(own.connected()).toBe(true);

      const c = await conversation();
      await prisma.conversation.update({ where: { id: c.id }, data: { mode: "human" } });
      await expect
        .poll(() => events.filter((e) => e.type === "conversation.updated").length, {
          timeout: 5_000,
        })
        .toBe(1);
    } finally {
      await own.stop();
    }
    // After stop() nothing reconnects and the backend is gone.
    await expect
      .poll(
        async () =>
          (
            await prisma.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM pg_stat_activity
               WHERE datname = current_database() AND application_name = 'smartops-api-events'`
          )[0]!.n,
        { timeout: 5_000 },
      )
      .toBe(1n); // the suite's listener only
  }, 20_000);
});
