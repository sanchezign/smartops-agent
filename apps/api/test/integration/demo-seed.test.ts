import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/common/db.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { getDemoContent } from "../../src/modules/demo/content/index.js";
import { seedDemo, type SeedResult } from "../../src/modules/demo/demo-seed.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { demoFingerprint } from "./demo-snapshot.js";
import { testDatabaseUrl } from "./db.js";
import {
  createScratchDatabase,
  databaseExists,
  prismaCli,
  type ScratchDatabase,
} from "./scratch-db.js";

/**
 * The demo seed on a real, freshly migrated `<test>_demo` database (phase 10 M3): derived from
 * TEST_DATABASE_URL (never smartops / smartops_demo) and dropped at the end. Checks that the
 * seed runs through the REAL catalog ingest, is deterministic, and that the periodic reset
 * (keepAuth) keeps visitors logged in without keeping any other row.
 */

const NOW = new Date("2026-09-20T15:00:00.000Z");
const ASSETS = fileURLToPath(new URL("../../demo", import.meta.url));
const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("demo seed (Postgres, <test>_demo)", () => {
  let demo: ScratchDatabase;
  let prisma: PrismaClient;

  beforeAll(async () => {
    demo = await createScratchDatabase(testDatabaseUrl!, "demo");
    const deploy = prismaCli(demo.url, ["migrate", "deploy"]);
    expect(deploy.status, deploy.output).toBe(0);
    prisma = createPrismaClient(demo.url, log);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (demo) {
      await demo.drop();
      expect(await databaseExists(testDatabaseUrl!, demo.name)).toBe(false);
    }
  }, 60_000); // DROP … WITH (FORCE) can be slow under coverage

  const seed = (keepAuth = false): Promise<SeedResult> => {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    return seedDemo({
      prisma,
      catalog: createCatalogIngestService({
        repository: createCatalogRepository(prisma),
        settings,
      }),
      users: {
        operator: {
          email: "operador@demo.smartops",
          password: "una frase pública de la demo",
          name: "Operador demo",
        },
      },
      logger: log,
      now: NOW,
      keepAuth,
      assetsDir: ASSETS,
    });
  };

  const snapshot = async () => ({
    products: (
      await prisma.product.findMany({ select: { name: true }, orderBy: { name: "asc" } })
    ).map((p) => p.name),
    suppliers: await prisma.supplier.count(),
    reviews: await prisma.reviewItem.groupBy({
      by: ["kind"],
      _count: true,
      orderBy: { kind: "asc" },
    }),
  });

  it("seeds through the real ingest, deterministically, without a real WhatsApp recipient", async () => {
    const first = await seed();
    expect(first.suppliers).toBeGreaterThanOrEqual(3);
    expect(first.products).toBeGreaterThan(30);
    expect(first.priceChanges).toBeGreaterThan(0);
    expect(first.reviewItems).toBeGreaterThan(0);
    const before = await snapshot();

    // Only the demo operator: no admin without DEMO_ADMIN_PASSWORD (phase 12 rule).
    expect(await prisma.user.findMany({ select: { role: true } })).toEqual([{ role: "operator" }]);
    const recipients = await prisma.setting.findUnique({
      where: { key: "notifications.whatsappRecipients" },
    });
    expect(recipients?.value).toEqual([]);
    // Every price came from the ingest: each product has at least one PriceChange row.
    const orphan = await prisma.product.count({ where: { priceChanges: { none: {} } } });
    expect(orphan).toBe(0);

    const second = await seed();
    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("the Spanish seed is byte-for-byte what it was before the content became data (fingerprint)", async () => {
    await seed();
    const first = await demoFingerprint(prisma);
    await seed();
    expect(await demoFingerprint(prisma), "two seeds give the same fingerprint").toEqual(first);
    const file = new URL("../fixtures/demo-seed-es.snapshot.json", import.meta.url);
    if (process.env.DEMO_SNAPSHOT_RECORD === "1") {
      writeFileSync(
        file,
        `${JSON.stringify(first, null, 2)}
`,
      );
    }
    expect(existsSync(file), "record it with DEMO_SNAPSHOT_RECORD=1 on the ORIGINAL seed").toBe(
      true,
    );
    expect(first).toEqual(JSON.parse(readFileSync(file, "utf8")));
  }, 180_000);

  it("the English content seeds the same story, in English, with no recording (phase 14 M5c)", async () => {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    const content = getDemoContent("en");
    const run = () =>
      seedDemo({
        prisma,
        catalog: createCatalogIngestService({
          repository: createCatalogRepository(prisma),
          settings,
        }),
        users: {
          operator: {
            email: "operador@demo.smartops",
            password: "una frase pública de la demo",
            name: "Operador demo",
          },
        },
        logger: log,
        now: NOW,
        assetsDir: ASSETS,
        content,
      });
    const first = await run();
    expect(first.suppliers).toBeGreaterThanOrEqual(3);
    expect(await prisma.supplier.count()).toBeGreaterThanOrEqual(6);
    expect(first.priceChanges).toBeGreaterThan(0);
    expect(first.reviewItems).toBeGreaterThan(0);
    expect((await prisma.setting.findUnique({ where: { key: "business.language" } }))?.value).toBe(
      "en",
    );

    // The Canadian supplier quotes in CAD; the "currency changed" review exists.
    const norvale = await prisma.supplier.findFirstOrThrow({
      where: { name: "Norvale Electric Supply Ltd." },
      include: { products: { select: { currency: true } } },
    });
    expect(new Set(norvale.products.map((p) => p.currency))).toContain("CAD");
    expect(
      await prisma.reviewItem.count({ where: { kind: "currency_changed", status: "pending" } }),
    ).toBeGreaterThan(0);

    // Nothing Spanish ended up in the catalog or in the conversation.
    const names = [
      ...(await prisma.product.findMany({ select: { name: true } })).map((p) => p.name),
      ...(await prisma.supplier.findMany({ select: { name: true } })).map((s) => s.name),
      ...(await prisma.message.findMany({ select: { text: true } })).map((m) => m.text ?? ""),
    ];
    for (const text of names) expect(text, text).not.toMatch(/[áéíóúñ¿¡]/i);

    // Deterministic like the Spanish one.
    const fingerprint = await demoFingerprint(prisma);
    await run();
    expect(await demoFingerprint(prisma)).toEqual(fingerprint);
    await seed(); // leave the Spanish seed (and its one operator) for the next tests
  }, 180_000);

  it("the reset keeps users and their sessions, and everything else is rebuilt", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const session = await prisma.authSession.create({
      data: {
        userId: user.id,
        idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      },
    });
    // Ended sessions of the shared public operator (phase 12) must not pile up across resets.
    const ended = await Promise.all(
      [
        { revokedAt: NOW, revokeReason: "logout" }, // logged out
        { idleExpiresAt: new Date(NOW.getTime() - 1) }, // idle too long
        { expiresAt: new Date(NOW.getTime() - 1) }, // past the absolute end
      ].map((extraFields) =>
        prisma.authSession.create({
          data: {
            userId: user.id,
            idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
            expiresAt: new Date(NOW.getTime() + 86_400_000),
            ...extraFields,
            refreshTokens: { create: { tokenHash: `ended-${crypto.randomUUID()}` } },
          },
        }),
      ),
    );
    const extra = await prisma.supplier.create({
      data: { name: "Dejado por un visitante", normalizedName: "dejado por un visitante" },
    });

    await seed(true);

    expect((await prisma.user.findFirstOrThrow()).id).toBe(user.id);
    expect(await prisma.authSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(await prisma.authSession.count({ where: { id: { in: ended.map((s) => s.id) } } })).toBe(
      0,
    );
    expect(
      await prisma.refreshToken.count({ where: { tokenHash: { startsWith: "ended-" } } }),
    ).toBe(0);
    expect(await prisma.supplier.findUnique({ where: { id: extra.id } })).toBeNull();
  }, 120_000);

  it("a reset retires a demo operator that is no longer THE public one (phase 14): inactive, logged out", async () => {
    await seed(false);
    const hash = (await prisma.user.findFirstOrThrow()).passwordHash;
    const old = await prisma.user.create({
      data: {
        email: "demo@ferreteria.demo",
        name: "Old demo",
        passwordHash: hash,
        role: "operator",
      },
    });
    const manualAdmin = await prisma.user.create({
      data: { email: "owner@x.uy", name: "Owner", passwordHash: hash, role: "admin" },
    });
    const oldSession = await prisma.authSession.create({
      data: {
        userId: old.id,
        idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      },
    });

    await seed(true);

    const retired = await prisma.user.findUniqueOrThrow({ where: { id: old.id } });
    expect(retired.active).toBe(false);
    const session = await prisma.authSession.findUniqueOrThrow({ where: { id: oldSession.id } });
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokeReason).toBe("user_deactivated");
    // the configured public operator keeps working; an admin made by hand is never touched
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email: "operador@demo.smartops" } })).active,
    ).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: manualAdmin.id } })).active).toBe(
      true,
    );
  }, 120_000);
});
