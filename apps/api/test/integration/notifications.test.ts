import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { errors } from "../../src/common/errors/app-error.js";
import type { OutboundService } from "../../src/modules/messaging/outbound.service.js";
import {
  createNotificationRepository,
  PANEL,
} from "../../src/modules/notifications/notification.repository.js";
import { createNotificationService } from "../../src/modules/notifications/notification.service.js";
import { createSupplierAckService } from "../../src/modules/notifications/supplier-ack.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Notifications against Postgres (phase 6 M3, anti-spam): actionable only, one digest per
 * recipient and window, hourly cap (excess waits for the next digest), critical errors
 * skip the window with their own cap, template vs panel-only outside the 24 h window.
 */

const log = pino({ level: "silent" });
const OWNER = "59899000999";

describe.skipIf(!testDatabaseUrl)("notifications (Postgres)", () => {
  let prisma: PrismaClient;
  let clock: Date;
  const scheduled: { digestId: string; startAfter: Date }[] = [];

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE notification_items, notification_digests, alerts, review_items, price_changes, ingestion_runs, products, suppliers, settings CASCADE",
    );
    await prisma.setting.create({
      data: { key: "notifications.whatsappRecipients", value: [OWNER] },
    });
    clock = new Date("2026-10-05T10:00:00Z");
    scheduled.length = 0;
  });

  function outbound(behaviour: "open" | "closed" | "closed_no_optin" | "opted_out" = "open") {
    const send = vi.fn(async (input: Parameters<OutboundService["send"]>[0]) => {
      if (behaviour === "opted_out")
        throw errors.optedOut({ contactId: null, optOutAt: new Date().toISOString() });
      if (input.content.kind === "text" && behaviour !== "open")
        throw errors.windowClosed({ lastInboundAt: null, closedAt: null });
      if (input.content.kind === "template" && behaviour === "closed_no_optin")
        throw errors.optInRequired({ contactId: null });
      return { messageId: randomUUID(), conversationId: null, duplicate: false };
    });
    return {
      send,
      recordManualOptIn: vi.fn(),
      processOutbound: vi.fn(),
    } as unknown as OutboundService & {
      send: typeof send;
    };
  }

  function service(out = outbound()) {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const repository = createNotificationRepository(prisma, {
      scheduleDigestInTx: async (_tx, digestId, startAfter) => {
        scheduled.push({ digestId, startAfter });
      },
    });
    return {
      out,
      repository,
      svc: createNotificationService({ repository, settings, outbound: out, now: () => clock }),
      ack: createSupplierAckService({ repository, settings, outbound: out }),
    };
  }

  /** A run with price changes (%), low-stock alerts and pending reviews. */
  async function runWith(input: { pcts?: number[]; lowStock?: number; reviews?: number } = {}) {
    const supplier = await prisma.supplier.create({
      data: { name: "Distribuidora Ejemplo", normalizedName: "distribuidora ejemplo" },
    });
    const contact = await prisma.contact.create({
      data: {
        waId: `59899${Math.floor(Math.random() * 1e6)}`,
        kind: "supplier",
        supplierId: supplier.id,
      },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "lista",
      },
    });
    const run = await prisma.ingestionRun.create({
      data: {
        messageId: message.id,
        supplierId: supplier.id,
        status: "ingested",
        report: { counts: { updated: (input.pcts ?? []).length, created: 0 } },
      },
    });
    for (const [i, pct] of (input.pcts ?? []).entries()) {
      const product = await prisma.product.create({
        data: {
          supplierId: supplier.id,
          name: `P${i}`,
          normalizedName: `p${i}`,
          price: 100,
          currency: "UYU",
        },
      });
      await prisma.priceChange.create({
        data: {
          productId: product.id,
          oldPrice: 100,
          oldCurrency: "UYU",
          newPrice: 100 + pct,
          newCurrency: "UYU",
          changePct: pct,
          ingestionRunId: run.id,
        },
      });
    }
    for (let i = 0; i < (input.lowStock ?? 0); i += 1)
      await prisma.alert.create({
        data: { type: "low_stock", title: "stock", ingestionRunId: run.id },
      });
    for (let i = 0; i < (input.reviews ?? 0); i += 1)
      await prisma.reviewItem.create({
        data: {
          ingestionRunId: run.id,
          scope: "line",
          kind: "product_match",
          dedupeKey: `line:${i}`,
          reasons: ["product_match"],
          proposal: {},
        },
      });
    return { run, conversation };
  }

  it("a run without news notifies nobody; an actionable one goes to the panel and to a digest", async () => {
    const { svc } = service();
    const quiet = await runWith({ pcts: [2, 3] });
    expect(await svc.notify({ kind: "run", runId: quiet.run.id }, log)).toEqual({
      notified: false,
      reason: "nothing_actionable",
      items: 0,
    });
    const busy = await runWith({ pcts: [2, 15], reviews: 1 });
    expect(await svc.notify({ kind: "run", runId: busy.run.id }, log)).toEqual({
      notified: true,
      items: 2,
    });
    const items = await prisma.notificationItem.findMany({ orderBy: { recipient: "asc" } });
    expect(items.map((i) => i.recipient)).toEqual([OWNER, PANEL]);
    expect(items[0]?.title).toBe(
      "Distribuidora Ejemplo: 2 aumentos (1 mayor al 10 %), 1 revisión pendiente",
    );
    const [digest] = await prisma.notificationDigest.findMany();
    expect(digest).toMatchObject({ recipient: OWNER, status: "open", critical: false });
    expect(digest!.windowEndsAt.getTime() - clock.getTime()).toBe(10 * 60_000);
    expect(scheduled).toEqual([{ digestId: digest!.id, startAfter: digest!.windowEndsAt }]);
    // n8n retries are harmless.
    expect(await svc.notify({ kind: "run", runId: busy.run.id }, log)).toMatchObject({
      reason: "duplicate",
    });
    expect(await prisma.notificationItem.count()).toBe(2);
  });

  it("15 lists on a Monday morning → ONE WhatsApp for the window", async () => {
    const { svc, out } = service();
    for (let i = 0; i < 15; i += 1) {
      const { run } = await runWith({ pcts: [12, 3] });
      clock = new Date(clock.getTime() + 30_000);
      await svc.notify({ kind: "run", runId: run.id }, log);
    }
    const digests = await prisma.notificationDigest.findMany();
    expect(digests).toHaveLength(1);
    clock = new Date(digests[0]!.windowEndsAt.getTime() + 1000);
    expect(await svc.processDigest(digests[0]!.id, log)).toEqual({ outcome: "sent" });
    expect(out.send).toHaveBeenCalledTimes(1);
    expect(out.send.mock.calls[0]![0]).toMatchObject({
      recipient: { waId: OWNER },
      content: {
        kind: "text",
        body: "SmartOps · 15 listas procesadas: 30 aumentos (15 mayores al 10 %). Detalle en el panel.",
      },
      idempotencyKey: `digest:${digests[0]!.id}`,
    });
  });

  it("hourly cap: the excess waits and goes in the next digest", async () => {
    await prisma.setting.create({ data: { key: "notifications.maxPerHour", value: 1 } });
    const { svc, out } = service();
    const first = await runWith({ pcts: [20] });
    await svc.notify({ kind: "run", runId: first.run.id }, log);
    const [d1] = await prisma.notificationDigest.findMany();
    clock = new Date(d1!.windowEndsAt.getTime() + 1000);
    await svc.processDigest(d1!.id, log); // sent at 10:10

    const second = await runWith({ pcts: [25] });
    await svc.notify({ kind: "run", runId: second.run.id }, log);
    const d2 = await prisma.notificationDigest.findFirstOrThrow({ where: { status: "open" } });
    clock = new Date(d2.windowEndsAt.getTime() + 1000); // 10:20:01, cap reached
    expect(await svc.processDigest(d2.id, log)).toEqual({ outcome: "postponed" });
    const postponed = await prisma.notificationDigest.findUniqueOrThrow({ where: { id: d2.id } });
    expect(postponed.windowEndsAt.getTime()).toBeGreaterThan(clock.getTime() + 40 * 60_000);

    const third = await runWith({ lowStock: 1 });
    await svc.notify({ kind: "run", runId: third.run.id }, log); // joins the postponed digest
    expect(await prisma.notificationItem.count({ where: { digestId: d2.id } })).toBe(2);
    clock = new Date(postponed.windowEndsAt.getTime() + 1000);
    expect(await svc.processDigest(d2.id, log)).toEqual({ outcome: "sent" });
    expect(out.send).toHaveBeenCalledTimes(2);
    expect(out.send.mock.calls[1]![0].content).toMatchObject({
      body: "SmartOps · 2 listas procesadas: 1 aumento (1 mayor al 10 %), 1 producto con stock bajo. Detalle en el panel.",
    });
  });

  it("outside business hours a normal digest waits for the opening; a critical one goes now", async () => {
    await prisma.setting.create({
      data: {
        key: "businessHours",
        value: {
          timeZone: "America/Montevideo",
          days: [1, 2, 3, 4, 5].map((day) => ({ day, open: "09:00", close: "18:00" })),
        },
      },
    });
    const { svc, out } = service(); // clock: Monday 10:00Z = 07:00 in Montevideo (closed)
    const run = await runWith({ pcts: [20] });
    await svc.notify({ kind: "run", runId: run.run.id }, log);
    const digest = await prisma.notificationDigest.findFirstOrThrow({ where: { critical: false } });
    clock = new Date(digest.windowEndsAt.getTime() + 1000);
    expect(await svc.processDigest(digest.id, log)).toEqual({ outcome: "postponed" });
    const waiting = await prisma.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } });
    expect(waiting.windowEndsAt).toEqual(new Date("2026-10-05T12:00:00Z")); // 09:00 local
    expect(scheduled.at(-1)).toEqual({ digestId: digest.id, startAfter: waiting.windowEndsAt });
    expect(out.send).not.toHaveBeenCalled();

    await svc.recordN8nError({ workflow: "procesador", executionId: "1", message: "caído" }, log);
    const critical = await prisma.notificationDigest.findFirstOrThrow({
      where: { critical: true },
    });
    expect(await svc.processDigest(critical.id, log)).toEqual({ outcome: "sent" });

    clock = new Date("2026-10-05T12:00:01Z");
    expect(await svc.processDigest(digest.id, log)).toEqual({ outcome: "sent" });
    expect(out.send).toHaveBeenCalledTimes(2);
  });

  it("critical integration errors skip the window (own cap); beyond it they wait in the digest", async () => {
    await prisma.setting.create({ data: { key: "notifications.criticalMaxPerHour", value: 1 } });
    const { svc, out } = service();
    const first = await svc.recordN8nError(
      { workflow: "procesador", executionId: "101", message: "timeout" },
      log,
    );
    expect(first).toMatchObject({ notified: true });
    const critical = await prisma.notificationDigest.findFirstOrThrow({
      where: { critical: true },
    });
    expect(scheduled[0]).toEqual({ digestId: critical.id, startAfter: clock });
    expect(await svc.processDigest(critical.id, log)).toEqual({ outcome: "sent" });
    expect(out.send.mock.calls[0]![0].content).toMatchObject({
      body: "SmartOps · ⚠️ Error de integración (n8n · procesador): timeout Detalle en el panel.",
    });
    expect(
      await prisma.alert.count({ where: { type: "integration_error", severity: "critical" } }),
    ).toBe(1);

    await svc.recordN8nError(
      { workflow: "procesador", executionId: "102", message: "timeout" },
      log,
    );
    expect(await prisma.notificationDigest.count({ where: { critical: true } })).toBe(1);
    expect(
      await prisma.notificationDigest.count({ where: { critical: false, status: "open" } }),
    ).toBe(1);
    // Same execution reported twice → one item.
    expect(
      await svc.recordN8nError(
        { workflow: "procesador", executionId: "102", message: "timeout" },
        log,
      ),
    ).toMatchObject({ reason: "duplicate" });
  });

  it("outside the 24 h window: template if configured (with opt-in), else panel only", async () => {
    const { run } = await runWith({ pcts: [30] });
    const closed = service(outbound("closed"));
    await closed.svc.notify({ kind: "run", runId: run.id }, log);
    const digest = await prisma.notificationDigest.findFirstOrThrow();
    clock = new Date(digest.windowEndsAt.getTime() + 1000);
    expect(await closed.svc.processDigest(digest.id, log)).toEqual({ outcome: "panel_only" });
    expect(
      await prisma.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } }),
    ).toMatchObject({
      status: "panel_only",
      error: "window closed and no template configured",
    });

    await prisma.setting.create({
      data: {
        key: "notifications.template",
        value: { name: "alerta_smartops", languageCode: "es", bodyParam: true },
      },
    });
    const again = await runWith({ pcts: [40] });
    const templated = service(outbound("closed"));
    await templated.svc.notify({ kind: "run", runId: again.run.id }, log);
    const d2 = await prisma.notificationDigest.findFirstOrThrow({ where: { status: "open" } });
    clock = new Date(d2.windowEndsAt.getTime() + 1000);
    expect(await templated.svc.processDigest(d2.id, log)).toEqual({ outcome: "sent" });
    expect(templated.out.send.mock.calls[1]![0].content).toMatchObject({
      kind: "template",
      name: "alerta_smartops",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: expect.stringMatching(/^SmartOps · 1 lista/) }],
        },
      ],
    });
  });

  it("a recipient who opted out (ADR-017): digest falls back to panel_only on the first try (no template attempt)", async () => {
    const { run } = await runWith({ pcts: [30] });
    const optedOut = service(outbound("opted_out"));
    await optedOut.svc.notify({ kind: "run", runId: run.id }, log);
    const digest = await prisma.notificationDigest.findFirstOrThrow();
    clock = new Date(digest.windowEndsAt.getTime() + 1000);
    expect(await optedOut.svc.processDigest(digest.id, log)).toEqual({ outcome: "panel_only" });
    expect(optedOut.out.send).toHaveBeenCalledTimes(1); // no second (template) attempt
    expect(
      await prisma.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } }),
    ).toMatchObject({ status: "panel_only", error: "recipient opted out" });
  });

  it("customer queries and long voice notes are notified; the supplier ack is OFF by default", async () => {
    const { svc, ack, out } = service();
    const { run, conversation } = await runWith({ pcts: [5] });
    const customer = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        text: "¿Tienen candados de 40mm? ¿Precio?",
      },
    });
    expect(await svc.notify({ kind: "customer_query", messageId: customer.id }, log)).toMatchObject(
      { notified: true },
    );
    const alert = await prisma.alert.create({
      data: { type: "manual_attention", title: "Audio de 4:12 sin transcribir" },
    });
    expect(await svc.notify({ kind: "manual_attention", alertId: alert.id }, log)).toMatchObject({
      notified: true,
    });

    expect(await ack.ack(run.id, log)).toEqual({ sent: false, reason: "disabled" });
    await prisma.setting.create({ data: { key: "bot.supplierAck", value: true } });
    expect(await ack.ack(run.id, log)).toMatchObject({ sent: true });
    expect(out.send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: { conversationId: conversation.id },
        content: { kind: "text", body: "¡Gracias! Recibimos tu lista: 1 precio actualizado." },
        idempotencyKey: `ack:${run.id}`,
      }),
      log,
    );
    await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: "human" } });
    expect(await ack.ack(run.id, log)).toEqual({ sent: false, reason: "human_mode" });
    // Phase 7 (ADR-016): back to bot, but the list arrived while a person handled the
    // chat → no delayed automatic reply.
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { mode: "bot", humanUntil: null, modeChangedAt: new Date(Date.now() + 60_000) },
    });
    expect(await ack.ack(run.id, log)).toEqual({
      sent: false,
      reason: "received_during_human_mode",
    });
  });

  it("an opted-out supplier (ADR-017): the ack is skipped, the catalog was already updated", async () => {
    const { run, conversation } = await runWith({ pcts: [5] });
    const { ack, out } = service(outbound("opted_out"));
    await prisma.setting.create({ data: { key: "bot.supplierAck", value: true } });
    expect(await ack.ack(run.id, log)).toEqual({ sent: false, reason: "opted_out" });
    expect(out.send).toHaveBeenCalledOnce();
    // The run itself (catalog ingest) is untouched by opt-out — only the ack was blocked.
    expect(
      await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } }),
    ).toMatchObject({ mode: "bot" });
  });
});
