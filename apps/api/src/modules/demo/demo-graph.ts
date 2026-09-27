import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Logger } from "../../common/logger.js";
import { signWhatsAppBody } from "../whatsapp/whatsapp-signature.js";
import { buildStatus, type SimBusiness } from "./wa-payloads.js";
import { fakeMediaId, fakeWamid } from "./wa-ids.js";

/**
 * The public demo's own "Graph API" (phase 9 M8, ADR-021), served by the API ONLY in
 * DEMO_MODE, so the production WhatsApp client runs unchanged and nothing reaches Meta:
 *
 *   GET  /{v}/{media-id}                 → metadata + short-lived signed download URL (Bearer)
 *   GET  /media-download/{media-id}      → the bytes (Bearer + valid signature)
 *   POST /{v}/{phone-number-id}/messages → a wamid; then signed status webhooks back
 *                                          (sent → delivered → read) to our own webhook
 *
 * Media lives in memory (the demo injector puts the sample files here). Same shapes and
 * error format as Meta (checked by the production client and the simulator tests).
 */

export interface DemoMedia {
  bytes: Uint8Array;
  mimeType: string;
  filename: string | null;
}

export interface DemoMediaStore {
  put(media: DemoMedia): string;
  get(id: string): DemoMedia | null;
  clear(): void;
}

/** In-memory, bounded (oldest dropped first). */
export function createDemoMediaStore(max = 200): DemoMediaStore {
  const items = new Map<string, DemoMedia>();
  return {
    put(media) {
      const id = fakeMediaId();
      items.set(id, media);
      while (items.size > max) items.delete(items.keys().next().value!);
      return id;
    },
    get: (id) => items.get(id) ?? null,
    clear: () => items.clear(),
  };
}

export interface DemoOutbox {
  /** Messages the demo "sent" (never to Meta), newest last — for the tests and the logs. */
  sent: { wamid: string; to: string; type: string }[];
}

const VERSION = /^v\d+\.\d+$/;
const URL_TTL_MS = 5 * 60_000;

function graphError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ error: { message, type: "OAuthException", code, fbtrace_id: "demo" } });
}

export function createDemoGraphRouter(options: {
  store: DemoMediaStore;
  outbox: DemoOutbox;
  accessToken: string;
  /** Base URL the worker uses to reach this router (download URLs are built on it). */
  baseUrl: string;
  business: SimBusiness;
  /** Our own webhook, where the demo delivers status updates (signed like Meta). */
  webhook: { url: string; appSecret: string };
  logger: Logger;
  statusDelayMs?: number;
}): Router {
  const router = express.Router();
  const signingKey = randomBytes(32);
  const log = options.logger.child({ component: "demo-graph" });
  const statusDelayMs = options.statusDelayMs ?? 1_200;

  const authorized = (req: Request) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.accessToken}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const sign = (id: string, exp: number) =>
    createHmac("sha256", signingKey).update(`${id}:${exp}`).digest("base64url");

  router.get("/media-download/:mediaId", (req, res) => {
    if (!authorized(req)) return graphError(res, 401, 190, "Invalid OAuth access token.");
    const id = String(req.params.mediaId);
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? "");
    const expected = sign(id, exp);
    if (
      !Number.isFinite(exp) ||
      exp < Date.now() ||
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return graphError(res, 404, 100, "URL expired or invalid.");
    }
    const media = options.store.get(id);
    if (!media) return graphError(res, 404, 100, "Media not found.");
    res
      .status(200)
      .set({ "content-type": media.mimeType, "content-length": String(media.bytes.byteLength) });
    res.end(Buffer.from(media.bytes));
  });

  router.get("/:version/:mediaId", (req, res, next) => {
    if (!VERSION.test(String(req.params.version))) return next();
    if (!authorized(req)) return graphError(res, 401, 190, "Invalid OAuth access token.");
    const id = String(req.params.mediaId);
    const media = options.store.get(id);
    if (!media)
      return graphError(
        res,
        404,
        100,
        `Unsupported get request. Object with ID '${id}' does not exist.`,
      );
    const exp = Date.now() + URL_TTL_MS;
    res.json({
      messaging_product: "whatsapp",
      url: `${options.baseUrl}/media-download/${id}?exp=${exp}&sig=${sign(id, exp)}`,
      mime_type: media.mimeType,
      sha256: createHash("sha256").update(media.bytes).digest("hex"),
      file_size: media.bytes.byteLength,
      id,
    });
  });

  router.post(
    "/:version/:phoneNumberId/messages",
    express.json({ limit: "256kb" }),
    (req, res, next) => {
      if (!VERSION.test(String(req.params.version))) return next();
      if (!authorized(req)) return graphError(res, 401, 190, "Invalid OAuth access token.");
      const body = (req.body ?? {}) as { to?: string; recipient?: string; type?: string };
      const to = body.to ?? body.recipient ?? "";
      const wamid = fakeWamid();
      options.outbox.sent.push({ wamid, to, type: body.type ?? "text" });
      if (options.outbox.sent.length > 200) options.outbox.sent.shift();
      log.info({ type: body.type }, "demo message accepted (not sent to Meta)");
      res.json({
        messaging_product: "whatsapp",
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id: wamid }],
      });
      // Statuses come back like Meta's, through our own signed webhook.
      ["sent", "delivered", "read"].forEach((status, i) => {
        setTimeout(
          () => {
            const payload = buildStatus(options.business, {
              wamid,
              status: status as "sent" | "delivered" | "read",
              recipient: { waId: to, bsuid: null },
            });
            const raw = JSON.stringify(payload);
            void fetch(options.webhook.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-hub-signature-256": signWhatsAppBody(raw, options.webhook.appSecret),
              },
              body: raw,
              signal: AbortSignal.timeout(10_000),
            }).catch((err: unknown) => log.warn({ err }, "demo status webhook failed"));
          },
          statusDelayMs * (i + 1),
        ).unref();
      });
    },
  );

  return router;
}
