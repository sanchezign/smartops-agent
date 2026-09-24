import { Router } from "express";
import type { Logger } from "../../common/logger.js";
import { createHealthController } from "./health.controller.js";
import type { HealthRepository } from "./health.repository.js";
import { createHealthService } from "./health.service.js";

/** GET /api/v1/health — 200 when the DB answers, 503 otherwise. Not rate limited. */
export function createHealthRouter(deps: { repository: HealthRepository; logger: Logger }): Router {
  const controller = createHealthController(createHealthService(deps));
  const router = Router();
  router.get("/health", controller.get);
  return router;
}
