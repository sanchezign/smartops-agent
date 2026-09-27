import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import pg from "pg";
import { assertTestDatabase } from "./global-setup.js";

/**
 * Throw-away databases for the integration suite (phase 10 M3, user rule): a fresh database
 * to apply the migrations from scratch (the drift check's shadow) and a `<test>_demo` one for
 * the demo seed. Both are DERIVED from TEST_DATABASE_URL, which must already end in "_test"
 * (assertTestDatabase), so their names always start with "<something>_test_" — never the
 * development (`smartops`) nor the demo (`smartops_demo`) database — and they are dropped at
 * the end of the test that created them.
 */

export type ScratchSuffix = "shadow_test" | "demo";

export interface ScratchDatabase {
  name: string;
  url: string;
  /** DROP DATABASE … WITH (FORCE) — only ever for a name this module derived. */
  drop(): Promise<void>;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function deriveScratchName(testDatabaseUrl: string, suffix: ScratchSuffix): string {
  const { name } = assertTestDatabase(testDatabaseUrl);
  const derived = `${name}_${suffix}`;
  assertScratchName(testDatabaseUrl, derived);
  return derived;
}

/** The guard every create / drop goes through. */
export function assertScratchName(testDatabaseUrl: string, candidate: string): void {
  const { name } = assertTestDatabase(testDatabaseUrl);
  const allowed = (["shadow_test", "demo"] as const).map((s) => `${name}_${s}`);
  if (!allowed.includes(candidate)) {
    throw new Error(`refusing to touch "${candidate}": not a scratch database of "${name}"`);
  }
}

function adminClient(testDatabaseUrl: string): pg.Client {
  const url = new URL(testDatabaseUrl);
  url.pathname = "/postgres";
  return new pg.Client({ connectionString: url.toString() });
}

/** Creates the scratch database EMPTY (dropping a leftover of an interrupted run first). */
export async function createScratchDatabase(
  testDatabaseUrl: string,
  suffix: ScratchSuffix,
): Promise<ScratchDatabase> {
  const name = deriveScratchName(testDatabaseUrl, suffix);
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  const drop = async () => {
    assertScratchName(testDatabaseUrl, name);
    const admin = adminClient(testDatabaseUrl);
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  };
  await drop();
  const admin = adminClient(testDatabaseUrl);
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quote(name)}`);
  } finally {
    await admin.end();
  }
  return { name, url: url.toString(), drop };
}

export async function databaseExists(testDatabaseUrl: string, name: string): Promise<boolean> {
  const admin = adminClient(testDatabaseUrl);
  await admin.connect();
  try {
    const res = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return (res.rowCount ?? 0) > 0;
  } finally {
    await admin.end();
  }
}

const apiRoot = new URL("../../", import.meta.url);
/** The project's own Prisma CLI, run with this Node (no pnpm / shell in between). */
const PRISMA_CLI = createRequire(import.meta.url).resolve("prisma/build/index.js");

/**
 * Runs the Prisma CLI against `databaseUrl`. DATABASE_URL is passed explicitly and wins over
 * apps/api/.env (prisma.config.ts loads it with process.loadEnvFile, which never overrides).
 */
export function prismaCli(databaseUrl: string, args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
