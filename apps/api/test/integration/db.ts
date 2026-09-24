import { pino } from "pino";
import { inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/common/db.js";
import { assertTestDatabase } from "./global-setup.js";

/** Integration DB URL provided by the global setup; null → suites are skipped. */
export const testDatabaseUrl = inject("testDatabaseUrl");

export function createTestPrisma(): PrismaClient {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
  assertTestDatabase(testDatabaseUrl);
  return createPrismaClient(testDatabaseUrl, pino({ level: "silent" }));
}

/** Empties the tables touched by the WhatsApp flow (test database only). */
export async function resetWhatsAppTables(prisma: PrismaClient): Promise<void> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
  assertTestDatabase(testDatabaseUrl);
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE message_status_events, messages, media_files, conversations, contacts, webhook_events RESTART IDENTITY CASCADE`,
  );
}
