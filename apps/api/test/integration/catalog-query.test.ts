import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import type { AppError } from "../../src/common/errors/app-error.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { createCatalogQueryRepository } from "../../src/modules/admin/catalog-query.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Catalog / price history / alerts read model + rename and acknowledge (phase 9 M5). */

describe.skipIf(!testDatabaseUrl)("catalog query (Postgres)", () => {
  let prisma: PrismaClient;
  let userId: string;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE suppliers, products, price_changes, alerts, audit_logs, users CASCADE",
    );
    userId = (
      await prisma.user.create({
        data: { email: "a@x.uy", name: "Ana", passwordHash: "x", role: "admin" },
      })
    ).id;
  });

  const repo = () => createCatalogQueryRepository(prisma);

  async function setup() {
    const norte = await prisma.supplier.create({
      data: { name: "Distribuidora Norte", normalizedName: "distribuidora norte" },
    });
    const sur = await prisma.supplier.create({
      data: { name: "Pinturas del Sur", normalizedName: "pinturas del sur" },
    });
    const product = (supplierId: string, name: string, price: string, available = true) =>
      prisma.product.create({
        data: {
          supplierId,
          name,
          normalizedName: name.toLowerCase(),
          price: new Prisma.Decimal(price),
          currency: "UYU",
          available,
        },
      });
    const tornillo = await product(norte.id, "Tornillo 6mm", "12.5");
    await product(norte.id, "Tuerca 6mm", "5", false);
    await product(sur.id, "Rodillo 23cm", "340");
    const contact = await prisma.contact.create({ data: { waId: "59899000777" } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
      },
    });
    await prisma.priceChange.create({
      data: {
        productId: tornillo.id,
        oldPrice: null,
        oldCurrency: null,
        newPrice: new Prisma.Decimal("10"),
        newCurrency: "UYU",
        createdAt: new Date("2026-09-01T10:00:00Z"),
      },
    });
    await prisma.priceChange.create({
      data: {
        productId: tornillo.id,
        oldPrice: new Prisma.Decimal("10"),
        oldCurrency: "UYU",
        newPrice: new Prisma.Decimal("12.5"),
        newCurrency: "UYU",
        changePct: new Prisma.Decimal("25"),
        sourceMessageId: message.id,
        createdAt: new Date("2026-09-20T10:00:00Z"),
      },
    });
    return { norte, sur, tornillo, conversation };
  }

  it("suppliers with product counts; products filtered, searched and paged, with the last change", async () => {
    const { norte } = await setup();
    const suppliers = await repo().suppliers();
    expect(suppliers.map((s) => [s.name, s.products, s.available])).toEqual([
      ["Distribuidora Norte", 2, 1],
      ["Pinturas del Sur", 1, 1],
    ]);
    const page1 = await repo().products({ supplierId: norte.id, limit: 1 });
    expect(page1.items.map((p) => p.name)).toEqual(["Tornillo 6mm"]);
    expect(String(page1.items[0]!.lastChange!.changePct)).toBe("25");
    const page2 = await repo().products({
      supplierId: norte.id,
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((p) => [p.name, p.available])).toEqual([["Tuerca 6mm", false]]);
    expect(page2.nextCursor).toBeNull();
    expect((await repo().products({ q: "RODI", limit: 10 })).items.map((p) => p.name)).toEqual([
      "Rodillo 23cm",
    ]);
    expect(
      (await repo().products({ availability: "unavailable", limit: 10 })).items.map((p) => p.name),
    ).toEqual(["Tuerca 6mm"]);
  });

  it("price history oldest first, with the conversation of the message that set it", async () => {
    const { tornillo, conversation } = await setup();
    const product = await repo().product(tornillo.id);
    expect(product!.history.map((h) => [String(h.newPrice), h.conversationId])).toEqual([
      ["10", null],
      ["12.5", conversation.id],
    ]);
    expect(await repo().product("01a0dc63-e4b1-716c-a982-fbceaa90e2ba")).toBeNull();
  });

  it("rename: audited, normalized name follows, a taken name is refused", async () => {
    const { norte } = await setup();
    const renamed = await repo().renameSupplier({
      supplierId: norte.id,
      name: "Distribuidora Norte S.A.",
      actor: { userId },
    });
    expect(renamed).toMatchObject({ name: "Distribuidora Norte S.A.", changed: true });
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: norte.id } });
    expect(row.normalizedName).toBe("distribuidora norte");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplier.renamed" } });
    expect(audit).toMatchObject({
      entityId: norte.id,
      userId,
      data: { from: "Distribuidora Norte", to: "Distribuidora Norte S.A." },
    });
    await expect(
      repo().renameSupplier({ supplierId: norte.id, name: "PINTURAS DEL SUR", actor: { userId } }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<AppError>);
  });

  it("alerts: open ones first, acknowledge once (audited), idempotent", async () => {
    const { tornillo } = await setup();
    const alert = await prisma.alert.create({
      data: {
        type: "price_change",
        title: "Tornillo +25 %",
        productId: tornillo.id,
        status: "sent",
      },
    });
    await prisma.alert.create({
      data: { type: "low_stock", title: "Viejo", status: "acknowledged" },
    });
    const open = await repo().alerts({ status: "open", limit: 10 });
    expect(open.open).toBe(1);
    expect(open.items.map((a) => a.title)).toEqual(["Tornillo +25 %"]);
    expect(open.items[0]!.product).toEqual({ id: tornillo.id, name: "Tornillo 6mm" });
    expect((await repo().alerts({ status: "all", limit: 10 })).items).toHaveLength(2);
    expect(await repo().acknowledgeAlert({ alertId: alert.id, actor: { userId } })).toEqual({
      changed: true,
    });
    expect(await repo().acknowledgeAlert({ alertId: alert.id, actor: { userId } })).toEqual({
      changed: false,
    });
    expect(await prisma.auditLog.count({ where: { action: "alert.acknowledged" } })).toBe(1);
    expect((await repo().alerts({ status: "open", limit: 10 })).open).toBe(0);
  });
});
