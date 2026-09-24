import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

/**
 * Vitest global setup for integration tests (test/integration). Resolves
 * TEST_DATABASE_URL (process env, else apps/api/.env), refuses any database whose
 * name does not end in "_test" (tests TRUNCATE tables), creates it if missing and
 * applies migrations with `prisma migrate deploy`. Without TEST_DATABASE_URL the
 * integration suites are skipped.
 */

declare module "vitest" {
  interface ProvidedContext {
    testDatabaseUrl: string | null;
  }
}

function resolveTestDatabaseUrl(): string | null {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const dotenv = new URL("../../.env", import.meta.url);
  if (!existsSync(dotenv)) return null;
  // Only this key is read: the rest of .env never enters the test process.
  return parseEnv(readFileSync(dotenv, "utf8")).TEST_DATABASE_URL ?? null;
}

export function assertTestDatabase(url: string): { url: URL; name: string } {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/_test$/.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL must point to a database whose name ends in "_test" (got "${name}")`,
    );
  }
  return { url: parsed, name };
}

export default async function setup(project: TestProject): Promise<void> {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    project.provide("testDatabaseUrl", null);
    return;
  }

  const { url: parsed, name } = assertTestDatabase(url);
  const adminUrl = new URL(parsed);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) {
      // Identifier validated by assertTestDatabase + quoted.
      await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }

  execSync("pnpm exec prisma migrate deploy", {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  project.provide("testDatabaseUrl", url);
}
