import { readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./db.js";
import {
  assertScratchName,
  createScratchDatabase,
  databaseExists,
  deriveScratchName,
  prismaCli,
  type ScratchDatabase,
} from "./scratch-db.js";

/**
 * Migrations from scratch + drift check (phase 10 M3). A throw-away `<test>_shadow_test`
 * database (derived from TEST_DATABASE_URL, dropped at the end) gets every migration applied
 * from zero, then:
 * - `prisma migrate diff` (migrated DB → schema.prisma) must be EMPTY: a model edited without
 *   its migration, or a migration edited by hand, fails here;
 * - the objects Prisma does not model (CHECKs, triggers, partial unique indexes, STORAGE
 *   EXTERNAL — CLAUDE.md "keep them") must exist exactly as listed.
 */

const MIGRATIONS = new URL("../../prisma/migrations/", import.meta.url);
const migrationDirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("scratch database names", () => {
  const url = "postgresql://u:p@localhost:5432/smartops_test";
  it("are derived from the *_test database and nothing else", () => {
    expect(deriveScratchName(url, "shadow_test")).toBe("smartops_test_shadow_test");
    expect(deriveScratchName(url, "demo")).toBe("smartops_test_demo");
    for (const name of ["smartops", "smartops_demo", "smartops_test", "postgres", "x_test"])
      expect(() => assertScratchName(url, name), name).toThrow(/refusing/);
    expect(() => deriveScratchName("postgresql://u:p@h/smartops", "demo")).toThrow(/_test/);
  });
});

describe.skipIf(!testDatabaseUrl)("migrations (Postgres, from scratch)", () => {
  let shadow: ScratchDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    shadow = await createScratchDatabase(testDatabaseUrl!, "shadow_test");
    const deploy = prismaCli(shadow.url, ["migrate", "deploy"]);
    expect(deploy.status, deploy.output).toBe(0);
    client = new pg.Client({ connectionString: shadow.url });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (shadow) {
      await shadow.drop();
      expect(await databaseExists(testDatabaseUrl!, shadow.name)).toBe(false);
    }
  }, 60_000); // DROP … WITH (FORCE) can be slow under coverage

  const rows = async <T>(sql: string) => (await client.query(sql)).rows as T[];

  it("applies every migration, in order, and a second deploy is a no-op", async () => {
    const applied = await rows<{ migration_name: string; finished: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished
         FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(applied.map((r) => r.migration_name)).toEqual(migrationDirs);
    expect(applied.every((r) => r.finished)).toBe(true);
    const again = prismaCli(shadow.url, ["migrate", "deploy"]);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toMatch(/No pending migrations/i);
  }, 60_000);

  it("schema.prisma and the migrations describe the same database (no drift)", () => {
    const diff = prismaCli(shadow.url, [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
    ]);
    expect(diff.status, `drift between migrations and schema.prisma:\n${diff.output}`).toBe(0);
  }, 60_000);

  it("keeps the hand-written objects Prisma does not model", async () => {
    const checks = await rows<{ name: string }>(
      `SELECT conrelid::regclass::text || '.' || conname AS name FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY 1`,
    );
    expect(checks.map((r) => r.name)).toEqual([
      "contacts.contacts_identity_chk",
      "contacts.contacts_opt_in_chk",
      "contacts.contacts_opt_out_chk",
      "messages.messages_purpose_chk",
      "price_changes.price_changes_currency_changed_chk",
      "price_changes.price_changes_pct_null_on_currency_change_chk",
      "price_changes.price_changes_pct_requires_old_price_chk",
    ]);

    const triggers = await rows<{ name: string }>(
      `SELECT tgrelid::regclass::text || '.' || tgname AS name FROM pg_trigger
        WHERE NOT tgisinternal ORDER BY 1`,
    );
    expect(triggers.map((r) => r.name)).toEqual([
      "alerts.alerts_realtime",
      "contacts.contacts_realtime",
      "conversations.conversations_realtime",
      "ingestion_runs.ingestion_runs_realtime",
      "media_files.media_files_realtime",
      "messages.messages_realtime",
      "products.products_realtime_insert",
      "products.products_realtime_update",
      "review_items.review_items_realtime",
    ]);

    const partial = await rows<{ name: string }>(
      `SELECT i.indexrelid::regclass::text AS name FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indpred IS NOT NULL AND c.relnamespace = 'public'::regnamespace ORDER BY 1`,
    );
    expect(partial.map((r) => r.name)).toEqual([
      "price_changes_run_product_auto_key",
      "supplier_sheet_formats_active_key",
    ]);

    const [blob] = await rows<{ attstorage: string }>(
      `SELECT a.attstorage FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'media_blobs' AND a.attname = 'data'`,
    );
    expect(blob?.attstorage, "media_blobs.data STORAGE EXTERNAL (ADR-008)").toBe("e");
  });
});
