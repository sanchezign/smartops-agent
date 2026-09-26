import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import {
  createConversationQueryRepository,
  snippet,
} from "../../src/modules/admin/conversation-query.repository.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Inbox / chat / opted-out read model (phase 9 M3) against Postgres. */

const NOW = new Date("2026-09-27T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("snippet", () => {
  it("collapses whitespace and cuts at 120 chars with an ellipsis", () => {
    expect(snippet("hola\n\n  che")).toBe("hola che");
    expect(snippet("x".repeat(200))).toHaveLength(120);
    expect(snippet("x".repeat(200))!.endsWith("…")).toBe(true);
    expect(snippet(null)).toBeNull();
  });
});

describe.skipIf(!testDatabaseUrl)("conversation query (Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe("TRUNCATE TABLE suppliers, users CASCADE");
  });

  async function chat(input: {
    waId: string;
    name: string;
    kind: "supplier" | "customer";
    lastInboundMinutesAgo: number;
    messages: number;
    mode?: "bot" | "human";
    optedOut?: boolean;
  }) {
    const supplier =
      input.kind === "supplier"
        ? await prisma.supplier.create({
            data: { name: `${input.name} S.A.`, normalizedName: input.name.toLowerCase() },
          })
        : null;
    const contact = await prisma.contact.create({
      data: {
        waId: input.waId,
        name: input.name,
        kind: input.kind,
        supplierId: supplier?.id ?? null,
        ...(input.optedOut ? { optOutAt: minutesAgo(5), optOutSource: "keyword" as const } : {}),
      },
    });
    const last = minutesAgo(input.lastInboundMinutesAgo);
    const conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        mode: input.mode ?? "bot",
        lastInboundAt: last,
        lastMessageAt: last,
      },
    });
    for (let i = 0; i < input.messages; i += 1) {
      const at = new Date(last.getTime() - (input.messages - 1 - i) * 1000);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: "inbound",
          type: "text",
          author: "contact",
          text: `mensaje ${i + 1}`,
          waTimestamp: at,
          createdAt: at,
        },
      });
    }
    if (input.optedOut) {
      await prisma.contactConsentEvent.create({
        data: { contactId: contact.id, kind: "opt_out", method: "keyword", keyword: "baja" },
      });
    }
    return { contact, conversation };
  }

  const repo = () => createConversationQueryRepository(prisma, () => NOW);

  it("inbox: most recent first, last message snippet, 24 h window, cursor pagination", async () => {
    const ana = await chat({
      waId: "59899000001",
      name: "Ana",
      kind: "customer",
      lastInboundMinutesAgo: 10,
      messages: 2,
    });
    await chat({
      waId: "59899000002",
      name: "Norte",
      kind: "supplier",
      lastInboundMinutesAgo: 60 * 30,
      messages: 1,
    });
    const first = await repo().list({ filter: "all", limit: 1 });
    expect(first.items[0]).toMatchObject({
      id: ana.conversation.id,
      mode: "bot",
      window: { open: true },
      lastMessage: { snippet: "mensaje 2", direction: "inbound" },
      contact: { name: "Ana", waId: "59899000001", optOutAt: null },
    });
    const second = await repo().list({ filter: "all", limit: 1, cursor: first.nextCursor! });
    expect(second.items[0]).toMatchObject({
      contact: { name: "Norte", supplier: { name: "Norte S.A." } },
      window: { open: false },
    });
    expect(second.nextCursor).toBeNull();
  });

  it("filters (human, opted out, suppliers, customers) and search by name, supplier or phone", async () => {
    await chat({
      waId: "59899000001",
      name: "Ana",
      kind: "customer",
      lastInboundMinutesAgo: 1,
      messages: 1,
      mode: "human",
    });
    await chat({
      waId: "59899000002",
      name: "Norte",
      kind: "supplier",
      lastInboundMinutesAgo: 2,
      messages: 1,
    });
    await chat({
      waId: "59899000003",
      name: "Jorge",
      kind: "customer",
      lastInboundMinutesAgo: 3,
      messages: 1,
      optedOut: true,
    });
    const names = async (filter: Parameters<ReturnType<typeof repo>["list"]>[0]) =>
      (await repo().list(filter)).items.map((i) => i.contact.name);
    expect(await names({ filter: "human", limit: 10 })).toEqual(["Ana"]);
    expect(await names({ filter: "opted_out", limit: 10 })).toEqual(["Jorge"]);
    expect(await names({ filter: "suppliers", limit: 10 })).toEqual(["Norte"]);
    expect(await names({ filter: "customers", limit: 10 })).toEqual(["Ana", "Jorge"]);
    expect(await names({ filter: "all", q: "norte s.a", limit: 10 })).toEqual(["Norte"]);
    expect(await names({ filter: "all", q: "000003", limit: 10 })).toEqual(["Jorge"]);
    expect(await names({ filter: "all", q: "ANA", limit: 10 })).toEqual(["Ana"]);
  });

  it("chat history pages backwards and returns each page oldest first", async () => {
    const { conversation } = await chat({
      waId: "59899000001",
      name: "Ana",
      kind: "customer",
      lastInboundMinutesAgo: 1,
      messages: 5,
    });
    const last = await repo().messages(conversation.id, { limit: 2 });
    expect(last.items.map((m) => m.text)).toEqual(["mensaje 4", "mensaje 5"]);
    expect(last.hasMore).toBe(true);
    const before = await repo().messages(conversation.id, { limit: 3, before: last.items[0]!.id });
    expect(before.items.map((m) => m.text)).toEqual(["mensaje 1", "mensaje 2", "mensaje 3"]);
    expect(before.hasMore).toBe(false);
  });

  it("header with the window and the opted-out list with how it happened", async () => {
    const { conversation } = await chat({
      waId: "59899000003",
      name: "Jorge",
      kind: "customer",
      lastInboundMinutesAgo: 60,
      messages: 1,
      optedOut: true,
    });
    const header = await repo().get(conversation.id);
    expect(header).toMatchObject({
      mode: "bot",
      window: { open: true },
      contact: { optOutSource: "keyword" },
    });
    expect(await repo().get("01a0dc63-e4b1-716c-a982-fbceaa90e2ba")).toBeNull();
    const [jorge] = await repo().optedOut();
    expect(jorge).toMatchObject({
      name: "Jorge",
      conversationId: conversation.id,
      lastOptOut: { method: "keyword", keyword: "baja" },
    });
  });
});
