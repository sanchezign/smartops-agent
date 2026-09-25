import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../../common/logger.js";
import { requireInternalApiKey } from "../../common/middleware/internal-api-key.js";
import { createRateLimiter } from "../../common/middleware/security.js";
import { getValidated, validate } from "../../common/middleware/validate.js";
import type { CatalogIngestService } from "../catalog/catalog-ingest.service.js";
import type { IngestionService } from "../extraction/ingestion.service.js";
import type { SettingsService } from "../settings/settings.service.js";

/**
 * Internal API for n8n (/api/v1/internal/*, X-Internal-Api-Key). The backend owns
 * validation, idempotency and business rules; n8n only orchestrates:
 *   POST /classify        { messageId } → ingestion run (classification)
 *   POST /extract         { runId }     → extraction (locked per run)
 *   POST /catalog/ingest  { runId }     → catalog ingest (locked per run) + review items
 *   GET  /runs/:id                       → run status (poll it while "extracting";
 *                                          chunked extraction answers 202 in phase 5 M3b)
 *   GET  /rules                          → no-code rules (settings) for the notifier
 * All POSTs are idempotent: repeating one returns the stored result.
 * Never exposed to the frontend (no CORS origin needs it; the key is server-side only).
 */

export interface InternalDeps {
  ingestion: IngestionService;
  catalog: CatalogIngestService;
  settings: SettingsService;
}

const messageBody = z.object({ messageId: z.uuid() }).strict();
const runBody = z.object({ runId: z.uuid() }).strict();
const runParams = z.object({ id: z.uuid() });

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

  router.post("/classify", validate({ body: messageBody }), async (req, res) => {
    const { messageId } = getValidated<typeof messageBody>(res, "body");
    res.json(await deps.ingestion.classify(messageId, log(req)));
  });

  router.post("/extract", validate({ body: runBody }), async (req, res) => {
    const { runId } = getValidated<typeof runBody>(res, "body");
    res.json(await deps.ingestion.extract(runId, log(req)));
  });

  router.post("/catalog/ingest", validate({ body: runBody }), async (req, res) => {
    const { runId } = getValidated<typeof runBody>(res, "body");
    res.json(await deps.catalog.ingest(runId, log(req)));
  });

  router.get("/runs/:id", validate({ params: runParams }), async (req, res) => {
    const { id } = getValidated<typeof runParams>(res, "params");
    res.set("Cache-Control", "no-store");
    res.json(await deps.ingestion.getRun(id));
  });

  router.get("/rules", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ rules: await deps.settings.getAll(log(req)) });
  });

  return router;
}
