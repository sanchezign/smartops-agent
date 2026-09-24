import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type { Logger } from "./logger.js";

/**
 * Creates the PrismaClient (Prisma 7 + pg driver adapter).
 * server.ts creates exactly one instance and injects it into repositories.
 */
export function createPrismaClient(databaseUrl: string, logger: Logger): PrismaClient {
  const adapter = new PrismaPg(
    { connectionString: databaseUrl },
    {
      onPoolError: (err) => logger.error({ err }, "postgres pool error"),
      onConnectionError: (err) => logger.error({ err }, "postgres connection error"),
    },
  );
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
