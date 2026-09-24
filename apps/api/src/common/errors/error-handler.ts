import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError, errors, type ErrorResponseBody } from "./app-error.js";

interface MappedError {
  statusCode: number;
  body: ErrorResponseBody;
  /** true for unexpected failures (5xx) that must be logged with the stack. */
  unexpected: boolean;
}

/** Errors thrown by express.json() (body-parser) carry a `type` and a `status`. */
interface BodyParserError extends Error {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    err instanceof Error &&
    typeof (err as Partial<BodyParserError>).type === "string" &&
    typeof (err as Partial<BodyParserError>).status === "number"
  );
}

/** Maps any thrown value to the consistent JSON error shape. Pure — unit tested. */
export function mapError(
  err: unknown,
  options: { isProduction: boolean; requestId?: string },
): MappedError {
  const build = (
    statusCode: number,
    code: ErrorResponseBody["error"]["code"],
    message: string,
    details?: unknown,
  ): MappedError => ({
    statusCode,
    unexpected: statusCode >= 500,
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
    },
  });

  if (err instanceof AppError) {
    return build(err.statusCode, err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    return build(
      400,
      "VALIDATION_ERROR",
      "Request validation failed",
      err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return build(409, "CONFLICT", "Resource already exists");
    if (err.code === "P2025") return build(404, "NOT_FOUND", "Resource not found");
  }

  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") {
      return build(400, "INVALID_JSON", "Malformed JSON body");
    }
    if (err.type === "entity.too.large") {
      return build(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    }
    if (err.status >= 400 && err.status < 500) {
      return build(err.status, "BAD_REQUEST", "Invalid request body");
    }
  }

  const message =
    !options.isProduction && err instanceof Error && err.message
      ? err.message
      : "Internal server error";
  return build(500, "INTERNAL_ERROR", message);
}

/** Catch-all for unmatched routes (mounted after every router). */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(errors.notFound(`Route ${req.method} ${req.path} not found`));
};

/**
 * Centralized error middleware (must be the last middleware).
 * Express 5 forwards rejected promises from async handlers here automatically.
 */
export function createErrorHandler(options: { isProduction: boolean }): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const requestId = typeof req.id === "string" ? req.id : undefined;
    const mapped = mapError(err, { isProduction: options.isProduction, requestId });
    if (mapped.unexpected) {
      // pino-http picks up res.err and logs the request line at error level with the stack.
      res.err = err instanceof Error ? err : new Error(String(err));
    }
    res.status(mapped.statusCode).json(mapped.body);
  };
}
