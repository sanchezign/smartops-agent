import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { PrismaClient as GeneratedPrismaClient } from "../../src/generated/prisma/client.js";
import type {
  AlertStatus,
  AlertType,
  ReviewKind,
  ReviewScope,
} from "../../src/generated/prisma/enums.js";
import { createReviewQueryRepository } from "../../src/modules/admin/review-query.repository.js";
import { createTodoQueryRepository } from "../../src/modules/admin/todo-query.repository.js";
import type { Viewer } from "../../src/modules/admin/todo-rules.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** To do read model (phase 15, ADR-032) against Postgres. */

const ADMIN: Viewer = { role: "admin", demoMode: false };
const OPERATOR: Viewer = { role: "operator", demoMode: false };
const DEMO_OPERATOR: Viewer = { role: "operator", demoMode: true };

describe.skipIf(!testDatabaseUrl)("to do query (Postgres)", () => {
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
      "TRUNCATE TABLE alerts, review_items, ingestion_runs, products, suppliers CASCADE",
    );
  });

  const repo = (client: PrismaClient = prisma) =>
    createTodoQueryRepository(client, { reviewQuery: createReviewQueryRepository(client) });

  let seq = 0;
  async function conversation() {
    const contact = await prisma.contact.create({ data: { waId: `598990${++seq}` } });
    return prisma.conversation.create({ data: { contactId: contact.id } });
  }

  /** One list (message + ingestion run) with the given pending items, in creation order. */
  async function list(
    name: string,
    receivedAt: string | null,
    items: { scope: ReviewScope; kind: ReviewKind; status?: "pending" | "approved" }[],
    supplierName: string | null = name,
  ) {
    const conv = await conversation();
    const supplier = supplierName
      ? await prisma.supplier.create({
          data: { name: supplierName, normalizedName: `${supplierName.toLowerCase()}-${++seq}` },
        })
      : null;
    const message = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "inbound",
        type: "document",
        author: "contact",
        text: name,
        waTimestamp: receivedAt ? new Date(receivedAt) : null,
        createdAt: new Date(receivedAt ?? "2026-10-01T00:00:00Z"),
      },
    });
    const run = await prisma.ingestionRun.create({
      data: { messageId: message.id, supplierId: supplier?.id ?? null, status: "needs_review" },
    });
    for (const [i, item] of items.entries()) {
      await prisma.reviewItem.create({
        data: {
          ingestionRunId: run.id,
          supplierId: supplier?.id ?? null,
          scope: item.scope,
          kind: item.kind,
          status: item.status ?? "pending",
          dedupeKey: `${item.scope}:${i}`,
          reasons: [item.kind],
          proposal: { item: { name: `${name} line ${i}` } },
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
        },
      });
    }
    return { run, message, conversation: conv, supplier };
  }

  async function alert(type: AlertType, status: AlertStatus, payload: object = {}) {
    return prisma.alert.create({ data: { type, status, title: type, payload } });
  }

  /** The fixture of the counter tests: three lists and alerts of every category. */
  async function seed() {
    const norte = await list("Norte", "2026-10-03T10:00:00Z", [
      { scope: "run", kind: "column_mapping" },
    ]);
    const sur = await list("Sur", "2026-10-05T10:00:00Z", [
      { scope: "line", kind: "price_outlier" },
      { scope: "line", kind: "product_match" },
      { scope: "catalog", kind: "mark_unavailable" },
      { scope: "line", kind: "currency_changed", status: "approved" },
    ]);
    const unknown = await list(
      "Unknown",
      "2026-10-04T10:00:00Z",
      [{ scope: "run", kind: "unknown_supplier" }],
      null,
    );
    const voice = await conversation();
    const voiceMessage = await prisma.message.create({
      data: { conversationId: voice.id, direction: "inbound", type: "audio", author: "contact" },
    });
    await alert("manual_attention", "open", {
      reason: "audio_too_long",
      messageId: voiceMessage.id,
    });
    await alert("possible_opt_out", "sent", {
      contactId: voice.contactId,
      messageId: voiceMessage.id,
      matched: "no more",
    });
    await alert("possible_opt_out", "acknowledged", { matched: "stop it" });
    await alert("price_change", "open");
    await alert("low_stock", "open");
    await alert("integration_error", "open");
    return { norte, sur, unknown, voice };
  }

  it("the same data gives different counters to an admin, an operator and the demo operator", async () => {
    await seed();
    // admin: 1 column_mapping + 2 lines + 1 mark_unavailable + 1 unknown_supplier
    expect(await repo().summary(ADMIN)).toEqual({
      total: 7,
      reviews: { canResolve: 5, waitingForAdmin: 0 },
      alerts: 2,
    });
    // operator: lines only (the approved line never counts)
    expect(await repo().summary(OPERATOR)).toEqual({
      total: 4,
      reviews: { canResolve: 2, waitingForAdmin: 3 },
      alerts: 2,
    });
    // demo operator: + column_mapping (ADR-030), nothing else
    expect(await repo().summary(DEMO_OPERATOR)).toEqual({
      total: 5,
      reviews: { canResolve: 3, waitingForAdmin: 2 },
      alerts: 2,
    });
    // todo() carries the same counters
    expect((await repo().todo(DEMO_OPERATOR)).counts).toEqual(await repo().summary(DEMO_OPERATOR));
  });

  it("groups by list, newest message first, each list split for the viewer", async () => {
    const { norte, sur, unknown } = await seed();
    const view = await repo().todo(OPERATOR);
    expect(view.groupsTruncated).toBe(false);
    expect(view.groups.map((g) => g.run.id)).toEqual([sur.run.id, unknown.run.id, norte.run.id]);
    const [s, u, n] = view.groups;
    expect(s).toMatchObject({
      supplier: { id: sur.supplier!.id, name: "Sur" },
      message: { id: sur.message.id, conversationId: sur.conversation.id, text: "Sur" },
      pending: 3,
      reviews: { canResolve: 2, waitingForAdmin: 1 },
    });
    // Each item in ONE place: the operator's lines in `items`, the catalog-wide one in
    // `waitingItems` (list order in both; the approved line is not there).
    expect(s!.items.map((i) => i.kind)).toEqual(["price_outlier", "product_match"]);
    expect(s!.waitingItems.map((i) => i.kind)).toEqual(["mark_unavailable"]);
    expect(u!.items).toEqual([]);
    expect(u!.waitingItems.map((i) => i.kind)).toEqual(["unknown_supplier"]);
    // An admin: everything is theirs, nothing waits.
    const admin = await repo().todo(ADMIN);
    expect(admin.groups[0]!.items.map((i) => i.kind)).toEqual([
      "price_outlier",
      "product_match",
      "mark_unavailable",
    ]);
    for (const g of admin.groups) expect(g.waitingItems).toEqual([]);
    expect(u).toMatchObject({
      supplier: null,
      pending: 1,
      reviews: { canResolve: 0, waitingForAdmin: 1 },
    });
    expect(n).toMatchObject({ pending: 1, reviews: { canResolve: 0, waitingForAdmin: 1 } });
    // the demo operator may resolve Norte's column mapping
    const demo = await repo().todo(DEMO_OPERATOR);
    expect(demo.groups[2]!.reviews).toEqual({ canResolve: 1, waitingForAdmin: 0 });
    expect(demo.groups[2]!.items.map((i) => i.kind)).toEqual(["column_mapping"]);
    expect(n!.waitingItems.map((i) => i.kind)).toEqual(["column_mapping"]);
  });

  it("action alerts only, newest first, with the chat and the contact they refer to", async () => {
    const { voice } = await seed();
    const { alerts } = await repo().todo(OPERATOR);
    expect(alerts.map((a) => [a.type, a.status])).toEqual([
      ["possible_opt_out", "sent"],
      ["manual_attention", "open"],
    ]);
    for (const a of alerts) {
      expect(a.conversationId).toBe(voice.id);
      expect(a.contactId).toBe(voice.contactId);
    }
    expect(alerts[0]!.details).toEqual({ matched: "no more" });
    expect(alerts[1]!.details).toEqual({ reason: "audio_too_long" });
  });

  it("a run gate goes first in its list; a list with many items returns its first 5", async () => {
    await list("Big", "2026-10-06T10:00:00Z", [
      ...Array.from({ length: 7 }, () => ({
        scope: "line" as const,
        kind: "price_outlier" as const,
      })),
      { scope: "run", kind: "tax_basis_changed" },
    ]);
    const [group] = (await repo().todo(ADMIN)).groups;
    expect(group!.pending).toBe(8);
    expect(group!.items).toHaveLength(5);
    expect(group!.items[0]!.kind).toBe("tax_basis_changed");
    expect(
      group!.items.slice(1).map((i) => (i.proposal as { item: { name: string } }).item.name),
    ).toEqual(["Big line 0", "Big line 1", "Big line 2", "Big line 3"]);
  });

  it("at most 50 lists (the newest); a list without waTimestamp sorts last", async () => {
    await list("NoTimestamp", null, [{ scope: "line", kind: "price_outlier" }]);
    for (let i = 0; i < 51; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const hour = String(i % 24).padStart(2, "0");
      await list(`L${i}`, `2026-09-${day}T${hour}:00:00Z`, [
        { scope: "line", kind: "price_outlier" },
      ]);
    }
    const view = await repo().todo(ADMIN);
    expect(view.groups).toHaveLength(50);
    expect(view.groupsTruncated).toBe(true);
    expect(view.counts.reviews.canResolve).toBe(52); // the counters are never capped
    expect(view.groups.map((g) => g.message.text)).not.toContain("NoTimestamp");
    const shown = view.groups.map((g) => g.message.receivedAt.getTime());
    expect([...shown].sort((a, b) => b - a)).toEqual(shown);
  });

  it("nothing waiting → zeros and empty lists", async () => {
    expect(await repo().todo(OPERATOR)).toEqual({
      counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
      groups: [],
      groupsTruncated: false,
      alerts: [],
    });
  });

  /**
   * A fixed number of SQL statements whatever the amount of data (no N+1). Counted on a client
   * that logs every statement Prisma sends.
   */
  it("summary is 2 statements and todo a fixed handful, for 3 lists or for 51", async () => {
    const statements: string[] = [];
    const counting = new GeneratedPrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrl! }),
      log: [{ emit: "event", level: "query" }],
    });
    counting.$on("query", (e) => statements.push(e.query));
    const count = async (fn: () => Promise<unknown>) => {
      statements.length = 0;
      await fn();
      return statements.filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;
    };
    try {
      await seed();
      const small = {
        summary: await count(() => repo(counting).summary(OPERATOR)),
        todo: await count(() => repo(counting).todo(OPERATOR)),
      };
      for (let i = 0; i < 48; i++) {
        await list(`M${i}`, `2026-09-10T${String(i % 24).padStart(2, "0")}:00:00Z`, [
          { scope: "line", kind: "price_outlier" },
          { scope: "line", kind: "product_match" },
        ]);
      }
      const big = {
        summary: await count(() => repo(counting).summary(OPERATOR)),
        todo: await count(() => repo(counting).todo(OPERATOR)),
      };
      expect(small.summary).toBe(2);
      // 13 today: 2 counters + the lists SQL + per-list counts + the item views (6: Prisma 7
      // reads each nested relation with ONE `IN (...)` statement) + the alerts (3). Never per row.
      expect(small.todo).toBeLessThanOrEqual(13);
      expect(big).toEqual(small);
    } finally {
      await counting.$disconnect();
    }
  });
});
