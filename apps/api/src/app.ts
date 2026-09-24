import express, { type Express } from "express";
import helmet from "helmet";
import { createErrorHandler, notFoundHandler } from "./common/errors/error-handler.js";
import { decimalJsonReplacer } from "./common/json.js";
import type { Logger } from "./common/logger.js";
import { createHttpLogger } from "./common/middleware/http-logger.js";
import { createCors, createRateLimiter } from "./common/middleware/security.js";
import type { Env } from "./config/env.js";
import type { HealthRepository } from "./modules/health/health.repository.js";
import { createHealthRouter } from "./modules/health/health.routes.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  healthRepository: HealthRepository;
}

/** Builds the Express app without listening (server.ts listens; Supertest uses it directly). */
export function createApp({ env, logger, healthRepository }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // Number of trusted proxy hops (Render = 1) so req.ip / rate limiting see the client IP.
  app.set("trust proxy", env.TRUST_PROXY);
  // Prisma Decimal → string in every JSON response.
  app.set("json replacer", decimalJsonReplacer);

  app.use(createHttpLogger(logger));
  app.use(helmet());
  app.use(createCors(env.CORS_ORIGINS));
  app.use(
    "/api/v1",
    createRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      skipPaths: ["/health"],
    }),
  );

  // Phase 3: the WhatsApp webhook router (express.raw for signature checks) is
  // mounted HERE, before express.json.
  app.use(express.json({ limit: "1mb" }));

  const v1 = express.Router();
  v1.use(createHealthRouter({ repository: healthRepository, logger }));
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(createErrorHandler({ isProduction: env.NODE_ENV === "production" }));

  return app;
}
