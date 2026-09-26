import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { createReviewQueryRepository } from "../../src/modules/admin/review-query.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Review queue read model for the panel (phase 9 M2) against Postgres. */

describe.skipIf(!testDatabaseUrl)("review query (Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE review_items, ingestion_runs, products, suppliers CASCADE",
    );
  });

  async function setup() {
    const supplier = await prisma.supplier.create({
      data: { name: "Eléctrica Oriental", normalizedName: "electrica oriental" },
    });
    const other = await prisma.supplier.create({
      data: { name: "Barraca Este", normalizedName: "barraca este" },
    });
    const product = await prisma.product.create({
      data: {
        supplierId: supplier.id,
        name: "Cable 2mm",
        normalizedName: "cable 2mm",
        price: new Prisma.Decimal("45.5"),
        currency: "UYU",
      },
    });
    const contact = await prisma.contact.create({ data: { waId: "59899000222" } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const media = await prisma.mediaFile.create({
      data: { waMediaId: "m-1", mimeType: "application/pdf", filename: "lista.pdf" },
    });
    const when = new Date("2026-09-25T12:00:00Z");
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "document",
        author: "contact",
        text: "Lista nueva",
        mediaFileId: media.id,
        waTimestamp: when,
      },
    });
    const run = await prisma.ingestionRun.create({
      data: { messageId: message.id, supplierId: supplier.id, status: "needs_review" },
    });
    const base = { ingestionRunId: run.id, reasons: ["x"], proposal: {} };
    await prisma.reviewItem.create({
      data: {
        ...base,
        scope: "line",
        kind: "price_outlier",
        dedupeKey: "l1",
        supplierId: supplier.id,
        productId: product.id,
        createdAt: new Date("2026-09-25T12:00:02Z"),
      },
    });
    await prisma.reviewItem.create({
      data: {
        ...base,
        scope: "run",
        kind: "column_mapping",
        dedupeKey: "g1",
        supplierId: supplier.id,
        createdAt: new Date("2026-09-25T12:00:05Z"),
      },
    });
    await prisma.reviewItem.create({
      data: {
        ...base,
        scope: "catalog",
        kind: "mark_unavailable",
        dedupeKey: "c1",
        status: "approved",
      },
    });
    return { supplier, other, product, message, run };
  }

  it("lists pending items first by scope (run gates first), with their context", async () => {
    const { supplier, product, message, run } = await setup();
    const repo = createReviewQueryRepository(prisma);
    const items = await repo.list({});
    expect(items.map((i) => i.kind)).toEqual(["column_mapping", "price_outlier"]);
    const line = items[1]!;
    expect(line.supplier).toEqual({ id: supplier.id, name: "Eléctrica Oriental" });
    expect(line.product).toMatchObject({ id: product.id, name: "Cable 2mm", currency: "UYU" });
    expect(String(line.product!.price)).toBe("45.5");
    expect(line.run).toEqual({ id: run.id, status: "needs_review" });
    expect(line.message).toMatchObject({
      id: message.id,
      type: "document",
      text: "Lista nueva",
      receivedAt: new Date("2026-09-25T12:00:00Z"),
      media: { filename: "lista.pdf", mimeType: "application/pdf" },
    });
  });

  it("filters by status, scope, kind and supplier", async () => {
    const { supplier, other } = await setup();
    const repo = createReviewQueryRepository(prisma);
    expect((await repo.list({ status: "approved" })).map((i) => i.kind)).toEqual([
      "mark_unavailable",
    ]);
    expect((await repo.list({ scope: "line" })).map((i) => i.kind)).toEqual(["price_outlier"]);
    expect((await repo.list({ kind: "column_mapping" })).length).toBe(1);
    expect((await repo.list({ supplierId: supplier.id })).length).toBe(2);
    expect(await repo.list({ supplierId: other.id })).toEqual([]);
    expect((await repo.list({ limit: 1 })).length).toBe(1);
  });

  it("summary counts pending items per scope; get returns one or null", async () => {
    const { run } = await setup();
    const repo = createReviewQueryRepository(prisma);
    expect(await repo.summary()).toEqual({ total: 2, byScope: { run: 1, line: 1, catalog: 0 } });
    const [first] = await repo.list({});
    expect((await repo.get(first!.id))?.run.id).toBe(run.id);
    expect(await repo.get("01a0dc63-e4b1-716c-a982-fbceaa90e2ba")).toBeNull();
    expect((await repo.suppliers()).map((s) => s.name)).toEqual([
      "Barraca Este",
      "Eléctrica Oriental",
    ]);
  });
});
