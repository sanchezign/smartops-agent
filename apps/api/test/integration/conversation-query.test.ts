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
    kind: "supplier" | "customer" | "internal";
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
    const last = (await repo().messages(conversation.id, { limit: 2 }))!;
    expect(last.items.map((m) => m.text)).toEqual(["mensaje 4", "mensaje 5"]);
    expect(last.hasMore).toBe(true);
    const before = (await repo().messages(conversation.id, {
      limit: 3,
      before: last.items[0]!.id,
    }))!;
    expect(before.items.map((m) => m.text)).toEqual(["mensaje 1", "mensaje 2", "mensaje 3"]);
    expect(before.hasMore).toBe(false);
    // An unknown conversation is null (→ 404), not an empty chat.
    expect(await repo().messages("01a0dc63-e4b1-716c-a982-fbceaa90e2ba", { limit: 2 })).toBeNull();
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

  describe("needs a reply (phase 16 M1)", () => {
    type Cls = "customer_query" | "internal_order" | "other" | "price_list_full" | null;
    const KIND = { customer: "customer", team: "internal", supplier: "supplier" } as const;

    /** One conversation whose messages are [direction, author, minutesAgo, classification, extra]. */
    async function thread(
      name: string,
      kind: keyof typeof KIND,
      messages: {
        out?: "human" | "bot";
        minutesAgo: number;
        cls?: Cls;
        status?: "sent" | "failed" | "canceled";
        revoked?: boolean;
      }[],
    ) {
      const { conversation } = await chat({
        waId: `5989900${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`,
        name,
        kind: KIND[kind],
        lastInboundMinutesAgo: 1,
        messages: 0,
      });
      for (const m of messages) {
        const at = minutesAgo(m.minutesAgo);
        const message = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: m.out ? "outbound" : "inbound",
            type: "text",
            author: m.out ?? "contact",
            text: "x",
            ...(m.out
              ? { purpose: m.out === "human" ? ("human" as const) : ("auto_reply" as const) }
              : {}),
            status: m.out ? (m.status ?? "sent") : "received",
            revokedAt: m.revoked ? at : null,
            waTimestamp: at,
            createdAt: at,
          },
        });
        if (!m.out && m.cls)
          await prisma.ingestionRun.create({
            data: {
              messageId: message.id,
              classification: m.cls,
              prefilterRule: "customer_contact",
              status: "classified",
            },
          });
      }
      return conversation.id;
    }
    const waiting = async (filter: "all" | "needs_reply" = "all", q?: string) => {
      const { items } = await repo().list({ filter, ...(q ? { q } : {}), limit: 50 });
      return items.filter((i) => i.needsReply).map((i) => i.contact.name);
    };

    it("a question or an order nobody answered marks a customer and a team member", async () => {
      await thread("Ana", "customer", [{ minutesAgo: 30, cls: "customer_query" }]);
      await thread("Caroline", "team", [{ minutesAgo: 20, cls: "internal_order" }]);
      expect((await waiting()).sort()).toEqual(["Ana", "Caroline"]);
    });

    it("a person's reply (panel or phone) answers it; a reply BEFORE the question does not", async () => {
      await thread("Answered", "customer", [
        { minutesAgo: 30, cls: "customer_query" },
        { minutesAgo: 20, out: "human" },
      ]);
      await thread("Earlier", "customer", [
        { minutesAgo: 40, out: "human" },
        { minutesAgo: 30, cls: "customer_query" },
      ]);
      expect(await waiting()).toEqual(["Earlier"]);
    });

    it("a bot reply, a failed or canceled person's reply never answers it", async () => {
      await thread("Bot", "customer", [
        { minutesAgo: 30, cls: "customer_query" },
        { minutesAgo: 29, out: "bot" },
      ]);
      await thread("Failed", "customer", [
        { minutesAgo: 30, cls: "customer_query" },
        { minutesAgo: 29, out: "human", status: "failed" },
      ]);
      await thread("Canceled", "customer", [
        { minutesAgo: 30, cls: "customer_query" },
        { minutesAgo: 29, out: "human", status: "canceled" },
      ]);
      expect((await waiting()).sort()).toEqual(["Bot", "Canceled", "Failed"]);
    });

    it("chit-chat, acks after an answered question and not-yet-classified messages do not mark it", async () => {
      await thread("Chat", "customer", [{ minutesAgo: 30, cls: "other" }]);
      await thread("Thanks", "customer", [
        { minutesAgo: 30, cls: "customer_query" },
        { minutesAgo: 20, out: "human" },
        { minutesAgo: 10, cls: "other" },
      ]);
      await thread("Unclassified", "customer", [{ minutesAgo: 30, cls: null }]);
      expect(await waiting()).toEqual([]);
    });

    it("a supplier never needs a reply (its list is processed), a deleted question neither", async () => {
      await thread("Norte", "supplier", [{ minutesAgo: 30, cls: "price_list_full" }]);
      await thread("Norte2", "supplier", [{ minutesAgo: 30, cls: "customer_query" }]);
      await thread("Deleted", "customer", [
        { minutesAgo: 30, cls: "customer_query", revoked: true },
      ]);
      expect(await waiting()).toEqual([]);
    });

    it("the filter lists only those, and works together with the search", async () => {
      await thread("Ana", "customer", [{ minutesAgo: 30, cls: "customer_query" }]);
      await thread("Anibal", "customer", [{ minutesAgo: 25, cls: "customer_query" }]);
      await thread("Beto", "customer", [{ minutesAgo: 20, cls: "customer_query" }]);
      await thread("Carla", "customer", [
        { minutesAgo: 20, cls: "customer_query" },
        { minutesAgo: 10, out: "human" },
      ]);
      expect((await waiting("needs_reply")).sort()).toEqual(["Ana", "Anibal", "Beto"]);
      expect((await waiting("needs_reply", "an")).sort()).toEqual(["Ana", "Anibal"]);
      expect(await waiting("needs_reply", "carla")).toEqual([]);
      const { items } = await repo().list({ filter: "needs_reply", q: "beto", limit: 1 });
      expect(items).toHaveLength(1);
    });
  });
});
