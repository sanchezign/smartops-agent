import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { createDashboardRepository } from "../../src/modules/dashboard/dashboard.repository.js";
import { createDashboardService } from "../../src/modules/dashboard/dashboard.service.js";
import { NotADemoDatabaseError, seedDemo } from "../../src/modules/demo/demo-seed.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Dashboard aggregates against Postgres + the demo seed guard (phase 9 M1). */

const NOW = new Date("2026-09-27T15:00:00Z");
const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("dashboard (Postgres)", () => {
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
      "TRUNCATE TABLE ai_usages, review_items, ingestion_runs, alerts, integration_events CASCADE",
    );
  });

  async function message(when: Date) {
    const contact = await prisma.contact.create({
      data: { waId: `598990${Math.floor(Math.random() * 1e5)}` },
    });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    return prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "text",
        author: "contact",
        createdAt: when,
      },
    });
  }

  it("counts messages per local day, run outcomes, pre-filter savings and AI spend", async () => {
    const yesterday = new Date("2026-09-26T15:00:00Z");
    const m1 = await message(yesterday);
    const m2 = await message(NOW);
    const m3 = await message(NOW);
    const m4 = await message(NOW);
    await prisma.ingestionRun.create({ data: { messageId: m1.id, status: "ingested" } }); // automatic
    await prisma.ingestionRun.create({
      data: { messageId: m2.id, status: "classified", prefilterRule: "no_price_signal" },
    }); // automatic + pre-filtered
    const review = await prisma.ingestionRun.create({
      data: { messageId: m3.id, status: "ingested" },
    });
    await prisma.reviewItem.create({
      data: {
        ingestionRunId: review.id,
        scope: "line",
        kind: "price_outlier",
        dedupeKey: "k",
        reasons: [],
        proposal: {},
      },
    }); // needed a person
    await prisma.ingestionRun.create({ data: { messageId: m4.id, status: "extracting" } }); // in progress
    await prisma.aiUsage.create({
      data: {
        task: "classify",
        status: "ok",
        provider: "anthropic",
        model: "claude-sonnet-5",
        costUsd: new Prisma.Decimal("0.003"),
        createdAt: NOW,
      },
    });

    const service = createDashboardService({
      repository: createDashboardRepository(prisma),
      budget: { totalUsd: 4, dailyUsd: 0.5 },
      now: () => NOW,
    });
    const view = await service.get(7);
    expect(view.messages).toHaveLength(7);
    expect(view.messages.slice(-2).map((d) => d.count)).toEqual([1, 3]);
    expect(view.runs).toMatchObject({ automatic: 2, neededPerson: 1, failed: 0, inProgress: 1 });
    expect(view.runs.automationRate).toBeCloseTo(2 / 3);
    expect(view.prefilter).toEqual({
      total: 1,
      byRule: [{ rule: "no_price_signal", count: 1 }],
      savedUsd: "0.0030",
    });
    expect(String(view.ai.totalUsd)).toBe("0.003");
    expect(String(view.ai.todayUsd)).toBe("0.003");
    expect(view.pending.reviews).toBe(1);
  });

  it("the demo seed refuses the test database (only *_demo) and touches nothing", async () => {
    const before = await prisma.message.count();
    await message(NOW);
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    await expect(
      seedDemo({
        prisma,
        catalog: createCatalogIngestService({
          repository: createCatalogRepository(prisma),
          settings,
        }),
        users: { operator: { email: "d@x.uy", password: "una frase larga cualquiera", name: "D" } },
        logger: log,
      }),
    ).rejects.toBeInstanceOf(NotADemoDatabaseError);
    expect(await prisma.message.count()).toBe(before + 1);
  });
});
