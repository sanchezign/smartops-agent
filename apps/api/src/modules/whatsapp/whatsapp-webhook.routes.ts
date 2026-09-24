import express, { Router } from "express";
import type { WebhookQueue } from "../../jobs/queues.js";
import { createRateLimiter } from "../../common/middleware/security.js";
import { validate } from "../../common/middleware/validate.js";
import { createWhatsAppWebhookController } from "./whatsapp-webhook.controller.js";
import type { WhatsAppWebhookRepository } from "./whatsapp-webhook.repository.js";
import { verifyQuerySchema } from "./whatsapp-webhook.schemas.js";
import { createWhatsAppWebhookService } from "./whatsapp-webhook.service.js";

/** Meta webhook payloads can be up to 3 MB. */
const WEBHOOK_BODY_LIMIT = "3mb";

/**
 * GET/POST /api/v1/webhooks/whatsapp. Mounted in app.ts BEFORE express.json so the
 * POST handler gets the raw bytes needed for X-Hub-Signature-256. Has its own rate
 * limit (excluded from the global /api/v1 limiter).
 */
export function createWhatsAppWebhookRouter(deps: {
  repository: WhatsAppWebhookRepository;
  queue: WebhookQueue;
  appSecret: string;
  verifyToken: string;
  rateLimit: { windowMs: number; limit: number };
}): Router {
  const controller = createWhatsAppWebhookController(
    createWhatsAppWebhookService({
      repository: deps.repository,
      queue: deps.queue,
      appSecret: deps.appSecret,
      verifyToken: deps.verifyToken,
    }),
  );

  const router = Router();
  router.use(createRateLimiter(deps.rateLimit));
  router.get("/", validate({ query: verifyQuerySchema }), controller.verify);
  router.post(
    "/",
    express.raw({ type: "application/json", limit: WEBHOOK_BODY_LIMIT }),
    controller.receive,
  );
  return router;
}
