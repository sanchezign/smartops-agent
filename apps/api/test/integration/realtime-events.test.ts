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
});
