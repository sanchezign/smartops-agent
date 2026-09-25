import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { errors } from "../errors/app-error.js";

/**
 * Internal API authentication (n8n → backend, /api/v1/internal/*): shared secret in the
 * X-Internal-Api-Key header, compared in constant time (hashes of equal length). The
 * header is redacted from request logs (logger.ts).
 */
export const INTERNAL_API_KEY_HEADER = "x-internal-api-key";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function requireInternalApiKey(expectedKey: string): RequestHandler {
  const expected = digest(expectedKey);
  return (req, _res, next) => {
    const provided = req.get(INTERNAL_API_KEY_HEADER);
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      next(errors.unauthorized("Missing or invalid internal API key"));
      return;
    }
    next();
  };
}
