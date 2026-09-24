import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const REQUEST_ID_HEADER = "x-request-id";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Reuses an incoming X-Request-Id when it is safe (≤128 chars, [A-Za-z0-9._:-]),
 * otherwise generates a UUID. Prevents log injection via the header.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  if (candidate && SAFE_REQUEST_ID.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

/** pino-http `genReqId`: resolves the id and echoes it in the response header. */
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  res.setHeader("X-Request-Id", id);
  return id;
}
