import type { PrismaClient } from "../../common/db.js";

export interface HealthRepository {
  /** Round-trip to the database; rejects if it is unreachable. */
  ping(): Promise<void>;
}

export function createHealthRepository(prisma: PrismaClient): HealthRepository {
  return {
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}
