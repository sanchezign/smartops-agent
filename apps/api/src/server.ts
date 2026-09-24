import { createApp } from "./app.js";
import { createPrismaClient } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import { createHealthRepository } from "./modules/health/health.repository.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL, logger);
const healthRepository = createHealthRepository(prisma);

// Fail fast if the database is unreachable at startup (Render restarts the service).
try {
  await prisma.$connect();
  await healthRepository.ping();
  logger.info("database connected");
} catch (err) {
  logger.fatal({ err }, "database connection failed on startup");
  process.exit(1);
}

const app = createApp({ env, logger, healthRepository });
const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `api listening on http://localhost:${env.PORT}`,
  );
});

let shuttingDown = false;

function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, "shutting down");

  setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(() => {
    prisma
      .$disconnect()
      .catch((err: unknown) => logger.error({ err }, "error disconnecting prisma"))
      .finally(() => process.exit(exitCode));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});
