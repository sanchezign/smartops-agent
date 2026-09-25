import cors from "cors";
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { errors } from "../errors/app-error.js";

/**
 * CORS with an explicit allow-list. Requests without Origin (curl, server-to-server,
 * n8n, Meta webhooks) are allowed; browser requests from unknown origins get no
 * CORS headers, so the browser blocks them.
 */
export function createCors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowed.has(origin));
    },
    credentials: true,
    exposedHeaders: ["X-Request-Id"],
  });
}

/** Global rate limit for /api/v1 (IP-based; needs `trust proxy` behind Render's proxy). */
export function createRateLimiter(options: {
  windowMs: number;
  limit: number;
  skipPaths?: readonly string[];
  /** Path prefixes with their own limiter (e.g. "/internal/"). */
  skipPrefixes?: readonly string[];
}): RequestHandler {
  const skip = new Set(options.skipPaths ?? []);
  const prefixes = options.skipPrefixes ?? [];
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => skip.has(req.path) || prefixes.some((prefix) => req.path.startsWith(prefix)),
    handler: (_req, _res, next) => next(errors.rateLimited()),
  });
}
