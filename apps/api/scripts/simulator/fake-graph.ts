import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { maskPhone } from "../../src/common/phone.js";
import { fakeWamid } from "./ids.js";
import { formatSha256, type MediaStore } from "./media-store.js";
import { buildStatus, type SimBusiness, type SimContact, type SimError } from "./payloads.js";
import { postSignedWebhook } from "./webhook-client.js";

/**
 * Local stand-in for the Meta Graph API (WhatsApp Cloud API subset) for development
 * without a Meta account. Same paths, auth and error shapes as the real API, so the
 * production client works unchanged with WHATSAPP_GRAPH_BASE_URL=http://localhost:4010.
 *
 *   GET  /{v}/{media-id}?phone_number_id=…  → media metadata + short-lived download URL
 *   GET  /media-download/{media-id}?exp&sig → bytes (Bearer required, URL expires)
 *   POST /{v}/{phone-number-id}/messages    → wamid, then signed status webhooks back
 *   GET|POST /{v}/{waba-id}/subscribed_apps → fake subscription
 *
 * Faults (401 token, 404 media, 5xx, latency, failed deliveries) are configurable to
 * exercise retries. Binds to 127.0.0.1 by default. NEVER used in production
 * (env.ts rejects a non-Meta WHATSAPP_GRAPH_BASE_URL there).
 */

export type FaultTarget = "media-info" | "download" | "send" | "subscribed-apps";
export type FaultStatus = 401 | 404 | 429 | 500 | 503;
/** An HTTP error, or "corrupt" (download only: 200 with altered bytes → checksum mismatch). */
export type FaultSpec = FaultStatus | "corrupt";

export interface FakeGraphOptions {
  business: SimBusiness;
  accessToken: string;
  /** Used to sign the status webhooks sent back to the API. */
  appSecret: string;
  /** Where status webhooks are delivered (the API's webhook endpoint). */
  webhookUrl: string;
  mediaStore: MediaStore;
  logger: Logger;
  /** Delay between status webhooks (sent → delivered → read). */
  statusDelayMs?: number;
  statusFlow?: ("sent" | "delivered" | "read")[];
  /** Every outbound message fails with this Meta error code (e.g. 131030). */
  failSendCode?: number | null;
  /** Free-form (non-template) messages fail with 131047 (outside the 24h window). */
  outsideWindow?: boolean;
  /** Forced HTTP errors per endpoint. */
  faults?: Partial<Record<FaultTarget, FaultSpec>>;
  latencyMs?: number;
  shaFormat?: "hex" | "base64";
  /** Download URL lifetime (Meta: 5 minutes). */
  urlTtlMs?: number;
  now?: () => number;
}

interface SentMessage {
  wamid: string;
  to: string;
  type: string;
  body: Record<string, unknown>;
}

const VERSION = /^v\d+\.\d+$/;

export function createFakeGraph(options: FakeGraphOptions) {
  const now = options.now ?? (() => Date.now());
  const urlTtlMs = options.urlTtlMs ?? 5 * 60_000;
  const statusDelayMs = options.statusDelayMs ?? 1_000;
  const statusFlow = options.statusFlow ?? ["sent", "delivered", "read"];
  const signingKey = randomBytes(32);
  const timers = new Set<NodeJS.Timeout>();
  const sent: SentMessage[] = [];
  const log = options.logger;

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Graph API error shape: { error: { message, type, code, error_subcode?, fbtrace_id } }. */
  function graphError(
    res: ServerResponse,
    status: number,
    error: { message: string; type?: string; code: number; subcode?: number; details?: string },
  ): void {
    sendJson(res, status, {
      error: {
        message: error.message,
        type: error.type ?? "OAuthException",
        code: error.code,
        ...(error.subcode ? { error_subcode: error.subcode } : {}),
        ...(error.details
          ? { error_data: { messaging_product: "whatsapp", details: error.details } }
          : {}),
        fbtrace_id: `SIM${randomBytes(8).toString("hex")}`,
      },
    });
  }

  function faultResponse(res: ServerResponse, target: FaultTarget): boolean {
    const status = options.faults?.[target];
    if (!status || status === "corrupt") return false;
    const byStatus: Record<FaultStatus, { message: string; code: number; type?: string }> = {
      401: { message: "Error validating access token: Session has expired.", code: 190 },
      404: {
        message: "Unsupported get request. Object does not exist or cannot be loaded.",
        code: 100,
        type: "GraphMethodException",
      },
      429: { message: "(#130429) Rate limit hit", code: 130429 },
      500: { message: "An unknown error has occurred.", code: 1 },
      503: { message: "Service temporarily unavailable", code: 2 },
    };
    log.warn({ target, status }, "fake graph: injected fault");
    graphError(res, status, byStatus[status]);
    return true;
  }

  function authorized(req: IncomingMessage, res: ServerResponse): boolean {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const expected = Buffer.from(options.accessToken);
    const received = Buffer.from(token);
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
    graphError(res, 401, {
      message: token
        ? "Invalid OAuth access token - Cannot parse access token"
        : "An access token is required to request this resource.",
      code: token ? 190 : 104,
    });
    return false;
  }

  function signDownload(mediaId: string, exp: number): string {
    return createHmac("sha256", signingKey).update(`${mediaId}.${exp}`).digest("base64url");
  }

  function baseUrlOf(req: IncomingMessage): string {
    return `http://${req.headers.host ?? "127.0.0.1"}`;
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  }

  function schedule(fn: () => Promise<void>, delayMs: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn().catch((err: unknown) => log.error({ err }, "fake graph: scheduled task failed"));
    }, delayMs);
    timers.add(timer);
  }

  async function deliverStatus(
    message: SentMessage,
    status: "sent" | "delivered" | "read" | "failed",
    errors?: SimError[],
  ): Promise<void> {
    const recipient: SimContact = /^\d+$/.test(message.to)
      ? { waId: message.to, bsuid: null }
      : { waId: null, bsuid: message.to };
    const payload = buildStatus(options.business, {
      wamid: message.wamid,
      status,
      recipient,
      ...(errors ? { errors } : {}),
      category: message.type === "template" ? "utility" : "service",
    });
    const result = await postSignedWebhook(options.webhookUrl, payload, options.appSecret);
    log.info(
      { wamid: message.wamid, status, to: maskPhone(message.to), webhookStatus: result.status },
      "fake graph: status webhook delivered",
    );
  }

  function scheduleStatuses(message: SentMessage): void {
    const failCode =
      options.failSendCode ??
      (options.outsideWindow && message.type !== "template" ? 131047 : null);
    if (failCode) {
      schedule(() => deliverStatus(message, "failed", [{ code: failCode }]), statusDelayMs);
      return;
    }
    statusFlow.forEach((status, index) => {
      schedule(() => deliverStatus(message, status), statusDelayMs * (index + 1));
    });
  }

  function validateSend(body: unknown): { to: string; type: string } | string {
    if (!body || typeof body !== "object") return "Request body must be a JSON object";
    const b = body as Record<string, unknown>;
    if (b.messaging_product !== "whatsapp") return "The parameter messaging_product is required.";
    const to =
      typeof b.to === "string" ? b.to : typeof b.recipient === "string" ? b.recipient : null;
    if (!to) return "The parameter to is required.";
    const type = typeof b.type === "string" ? b.type : "text";
    if (type === "text") {
      const text = b.text as { body?: unknown } | undefined;
      if (typeof text?.body !== "string" || text.body.length === 0) {
        return "The parameter text['body'] is required.";
      }
    } else if (type === "template") {
      const template = b.template as { name?: unknown; language?: { code?: unknown } } | undefined;
      if (typeof template?.name !== "string") return "The parameter template['name'] is required.";
      if (typeof template.language?.code !== "string") {
        return "The parameter template['language']['code'] is required.";
      }
    } else if (!["image", "document", "audio", "video", "interactive", "reaction"].includes(type)) {
      return `(#100) Param type must be one of a supported message type (got ${type})`;
    }
    return { to, type };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const url = new URL(req.url ?? "/", "http://fake-graph.local");
    const parts = url.pathname.split("/").filter(Boolean);

    // Download URL (absolute URL returned by the media endpoint; requires Bearer like Meta).
    if (req.method === "GET" && parts[0] === "media-download" && parts[1]) {
      if (!authorized(req, res) || faultResponse(res, "download")) return;
      const mediaId = parts[1];
      const exp = Number(url.searchParams.get("exp"));
      const sig = url.searchParams.get("sig") ?? "";
      const media = options.mediaStore.get(mediaId);
      if (!media || !Number.isFinite(exp) || exp < now() || sig !== signDownload(mediaId, exp)) {
        // Meta answers an expired/invalid lookaside URL with 404.
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      let body: Buffer = media.bytes;
      if (options.faults?.download === "corrupt") {
        // Same length, last byte flipped: the SHA-256 no longer matches Meta's.
        body = Buffer.from(media.bytes);
        const last = body.length - 1;
        if (last >= 0) body[last] = (body[last] ?? 0) ^ 0xff;
        log.warn("fake graph: injected fault (corrupt download)");
      }
      res.writeHead(200, {
        "Content-Type": media.meta.mimeType,
        "Content-Length": String(body.length),
      });
      res.end(body);
      log.info({ mediaSize: media.meta.size }, "fake graph: media downloaded");
      return;
    }

    const [version, id, edge] = parts;
    if (!version || !VERSION.test(version) || !id) {
      graphError(res, 400, { message: "Unknown path components", code: 2500 });
      return;
    }
    if (!authorized(req, res)) return;

    // Media metadata.
    if (req.method === "GET" && !edge) {
      if (faultResponse(res, "media-info")) return;
      const phoneNumberId = url.searchParams.get("phone_number_id");
      const media = options.mediaStore.get(id);
      if (!media || (phoneNumberId && phoneNumberId !== options.business.phoneNumberId)) {
        graphError(res, 404, {
          message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
          code: 100,
          subcode: 33,
          type: "GraphMethodException",
        });
        return;
      }
      const exp = now() + urlTtlMs;
      sendJson(res, 200, {
        messaging_product: "whatsapp",
        url: `${baseUrlOf(req)}/media-download/${id}?exp=${exp}&sig=${signDownload(id, exp)}`,
        mime_type: media.meta.mimeType,
        sha256: formatSha256(media.meta.sha256Hex, options.shaFormat ?? "hex"),
        file_size: media.meta.size,
        id,
      });
      return;
    }

    // Outbound messages.
    if (req.method === "POST" && edge === "messages") {
      if (id !== options.business.phoneNumberId) {
        graphError(res, 400, {
          message: `(#100) Invalid parameter: phone number id ${id} is not this business number`,
          code: 100,
        });
        return;
      }
      if (faultResponse(res, "send")) return;
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        graphError(res, 400, { message: "Invalid JSON body", code: 100 });
        return;
      }
      const valid = validateSend(body);
      if (typeof valid === "string") {
        graphError(res, 400, { message: valid, code: 100 });
        return;
      }
      const message: SentMessage = {
        wamid: fakeWamid(),
        to: valid.to,
        type: valid.type,
        body: body as Record<string, unknown>,
      };
      sent.push(message);
      sendJson(res, 200, {
        messaging_product: "whatsapp",
        contacts: [{ input: valid.to, wa_id: valid.to }],
        messages: [
          {
            id: message.wamid,
            ...(valid.type === "template" ? { message_status: "accepted" } : {}),
          },
        ],
      });
      log.info(
        { wamid: message.wamid, type: message.type, to: maskPhone(message.to) },
        "fake graph: message accepted",
      );
      scheduleStatuses(message);
      return;
    }

    // WABA webhook subscription.
    if (edge === "subscribed_apps" && (req.method === "GET" || req.method === "POST")) {
      if (faultResponse(res, "subscribed-apps")) return;
      if (id !== options.business.wabaId) {
        graphError(res, 404, {
          message: "Unsupported request",
          code: 100,
          type: "GraphMethodException",
        });
        return;
      }
      sendJson(
        res,
        200,
        req.method === "POST"
          ? { success: true }
          : {
              data: [
                { whatsapp_business_api_data: { id: "sim-app", name: "SmartOps (simulator)" } },
              ],
            },
      );
      return;
    }

    graphError(res, 400, {
      message: `Unsupported ${req.method} request.`,
      code: 100,
      type: "GraphMethodException",
    });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error({ err }, "fake graph: request failed");
      if (!res.headersSent)
        graphError(res, 500, { message: "An unknown error has occurred.", code: 1 });
    });
  });

  return {
    server,
    /** Outbound messages accepted so far (for tests). */
    sent,
    async listen(port = 4010, host = "127.0.0.1"): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
      const address = server.address() as AddressInfo;
      return `http://${host}:${address.port}`;
    },
    async close(): Promise<void> {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type FakeGraph = ReturnType<typeof createFakeGraph>;
