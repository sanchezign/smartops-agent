import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../../common/logger.js";
import { requireInternalApiKey } from "../../common/middleware/internal-api-key.js";
import { createRateLimiter } from "../../common/middleware/security.js";
import { getValidated, validate } from "../../common/middleware/validate.js";
import type { CatalogIngestService } from "../catalog/catalog-ingest.service.js";
import type { IngestionService } from "../extraction/ingestion.service.js";
import type { NotificationService } from "../notifications/notification.service.js";
import { ackSchema, n8nErrorSchema, notifySchema } from "../notifications/notification.schemas.js";
import type { SupplierAckService } from "../notifications/supplier-ack.js";
import type { SettingsService } from "../settings/settings.service.js";

/**
 * Internal API for n8n (/api/v1/internal/*, X-Internal-Api-Key). The backend owns
 * validation, idempotency and business rules; n8n only orchestrates:
 *   POST /classify        { messageId } → ingestion run (classification)
 *   POST /extract         { runId }     → extraction (locked per run)
 *   POST /catalog/ingest  { runId }     → catalog ingest (locked per run) + review items
 *   GET  /runs/:id                       → run status (poll it while "extracting";
 *                                          chunked extraction answers 202 in phase 5 M3b)
 *   POST /notifications  { kind, … }     → actionable? → panel + WhatsApp digests
 *   POST /n8n/errors                     → error workflow → alert + critical notification
 *   POST /messages/ack   { runId }       → supplier acknowledgement (Setting bot.supplierAck)
 *   GET  /rules                          → no-code rules (settings) for the notifier
 * All POSTs are idempotent: repeating one returns the stored result.
 * Never exposed to the frontend (no CORS origin needs it; the key is server-side only).
 */

export interface InternalDeps {
  ingestion: IngestionService;
  catalog: CatalogIngestService;
  settings: SettingsService;
  notifications: Pick<NotificationService, "notify" | "recordN8nError">;
  supplierAck: Pick<SupplierAckService, "ack">;
}

const messageBody = z.object({ messageId: z.uuid() }).strict();
const runBody = z.object({ runId: z.uuid() }).strict();
const runParams = z.object({ id: z.uuid() });

/**
 * The request schemas of every internal route, keyed "METHOD /path" (relative to
 * /api/v1/internal). Source of the n8n contract (scripts/n8n/contract.ts → n8n/contract.json,
 * phase 10 M4): a test fails if this table and the mounted routes ever differ.
 */
export const INTERNAL_ROUTE_SCHEMAS = {
  "POST /classify": { body: messageBody },
  "POST /extract": { body: runBody },
  "POST /catalog/ingest": { body: runBody },
  "GET /runs/:id": { params: runParams },
  "POST /notifications": { body: notifySchema },
  "POST /n8n/errors": { body: n8nErrorSchema },
  "POST /messages/ack": { body: ackSchema },
  "GET /rules": {},
} as const;

export function createInternalRouter(
  deps: InternalDeps & {
    apiKey: string;
    logger: Logger;
    rateLimit: { windowMs: number; limit: number };
  },
): Router {
  const router = Router();
  router.use(createRateLimiter(deps.rateLimit));
  router.use(requireInternalApiKey(deps.apiKey));

  const log = (req: Parameters<RequestHandler>[0]) =>
    (req.log as Logger | undefined) ?? deps.logger;

  router.post("/classify", validate(INTERNAL_ROUTE_SCHEMAS["POST /classify"]), async (req, res) => {
    const { messageId } = getValidated<typeof messageBody>(res, "body");
    res.json(await deps.ingestion.classify(messageId, log(req)));
  });

  router.post("/extract", validate(INTERNAL_ROUTE_SCHEMAS["POST /extract"]), async (req, res) => {
    const { runId } = getValidated<typeof runBody>(res, "body");
    res.json(await deps.ingestion.extract(runId, log(req)));
  });

  router.post(
    "/catalog/ingest",
    validate(INTERNAL_ROUTE_SCHEMAS["POST /catalog/ingest"]),
    async (req, res) => {
      const { runId } = getValidated<typeof runBody>(res, "body");
      res.json(await deps.catalog.ingest(runId, log(req)));
    },
  );

  router.get("/runs/:id", validate(INTERNAL_ROUTE_SCHEMAS["GET /runs/:id"]), async (req, res) => {
    const { id } = getValidated<typeof runParams>(res, "params");
    res.set("Cache-Control", "no-store");
    res.json(await deps.ingestion.getRun(id));
  });

  router.post(
    "/notifications",
    validate(INTERNAL_ROUTE_SCHEMAS["POST /notifications"]),
    async (req, res) => {
      res.json(
        await deps.notifications.notify(getValidated<typeof notifySchema>(res, "body"), log(req)),
      );
    },
  );

  router.post(
    "/n8n/errors",
    validate(INTERNAL_ROUTE_SCHEMAS["POST /n8n/errors"]),
    async (req, res) => {
      res.json(
        await deps.notifications.recordN8nError(
          getValidated<typeof n8nErrorSchema>(res, "body"),
          log(req),
        ),
      );
    },
  );

  router.post(
    "/messages/ack",
    validate(INTERNAL_ROUTE_SCHEMAS["POST /messages/ack"]),
    async (req, res) => {
      const { runId } = getValidated<typeof ackSchema>(res, "body");
      res.json(await deps.supplierAck.ack(runId, log(req)));
    },
  );

  router.get("/rules", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ rules: await deps.settings.getAll(log(req)) });
  });

  return router;
}
