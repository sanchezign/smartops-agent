import express, { type Express } from "express";

/**
 * Builds the Express app without listening (so Supertest can use it).
 * Phase 2 adds: helmet, cors, rate limit, pino-http + request-id,
 * /api/v1 routes (health) and the centralized error middleware.
 */
export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  return app;
}
