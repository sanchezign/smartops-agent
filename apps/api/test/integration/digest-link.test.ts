import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createDigestLinkRepository } from "../../src/modules/admin/digest-link.repository.js";
import { newLinkToken } from "../../src/modules/notifications/notification.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** WhatsApp digest deep link /d/<token> (phase 9 M7). */

describe("newLinkToken", () => {
  it("256 random bits, URL-safe, never repeated", () => {
    const tokens = new Set(Array.from({ length: 1000 }, newLinkToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe.skipIf(!testDatabaseUrl)("digest link (Postgres)", () => {
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
      "TRUNCATE TABLE notification_items, notification_digests CASCADE",
    );
  });

  it("each item points to the screen that resolves it; the rest answers null (404)", async () => {
    const contact = await prisma.contact.create({ data: { waId: "59899000321", name: "Luis" } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
      },
    });
    const token = newLinkToken();
    const digest = await prisma.notificationDigest.create({
      data: { recipient: "59899000999", windowEndsAt: new Date(), linkToken: token },
    });
    const items = [
      {
        category: "order",
        title: "Pedido de Luis",
        data: {
          category: "order",
          messageId: message.id,
          contactName: "Luis",
          preview: "3 macetas",
        },
      },
      {
        category: "run_summary",
        title: "Norte: 1 revisión",
        data: {
          category: "run_summary",
          runId: "r",
          supplierName: "Norte",
          increases: 0,
          increasesOverThreshold: 0,
          thresholdPct: 10,
          lowStock: 0,
          pendingReviews: 1,
        },
      },
      {
        category: "run_summary",
        title: "Sur: 3 aumentos",
        data: {
          category: "run_summary",
          runId: "r2",
          supplierName: "Sur",
          increases: 3,
          increasesOverThreshold: 1,
          thresholdPct: 10,
          lowStock: 0,
          pendingReviews: 0,
        },
      },
      {
        category: "manual_attention",
        title: "Audio largo",
        data: { category: "manual_attention", title: "Audio largo" },
      },
    ] as const;
    for (const [i, item] of items.entries()) {
      await prisma.notificationItem.create({
        data: {
          recipient: "59899000999",
          category: item.category,
          dedupeKey: `k${i}`,
          title: item.title,
          data: item.data,
          digestId: digest.id,
          createdAt: new Date(Date.now() + i),
        },
      });
    }
    const repo = createDigestLinkRepository(prisma);
    const found = await repo.byToken(token);
    expect(found!.items.map((i) => [i.title, i.path])).toEqual([
      ["Pedido de Luis", `/conversaciones/${conversation.id}`],
      ["Norte: 1 revisión", "/revisiones"],
      ["Sur: 3 aumentos", "/catalogo"],
      ["Audio largo", "/alertas"],
    ]);
    expect(await repo.byToken(newLinkToken())).toBeNull(); // unknown
    expect(await repo.byToken(digest.id)).toBeNull(); // the id is not a key
    expect(await repo.byToken("../../etc")).toBeNull(); // malformed
  });
});
