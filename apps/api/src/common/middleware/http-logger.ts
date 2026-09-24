import type { IncomingMessage, ServerResponse } from "node:http";
import { pinoHttp } from "pino-http";
import type { Logger } from "../logger.js";
import { genReqId } from "./request-id.js";

const QUIET_PATHS = new Set(["/api/v1/health"]);

/** Express sets originalUrl; req.url is rewritten relative to the router mount point. */
function fullPath(req: IncomingMessage): string {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "";
  return url.split("?")[0] ?? "";
}

/** pino-http: one compact log line per request, with request-id on every child log (req.log). */
export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      // Health checks (Render pings them constantly) only at debug level.
      if (QUIET_PATHS.has(fullPath(req))) return "debug";
      return "info";
    },
    serializers: {
      req: (req: IncomingMessage & { id?: unknown; remoteAddress?: string }) => ({
        id: req.id,
        method: req.method,
        url: (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url,
        remoteAddress: req.remoteAddress,
      }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
  });
}
