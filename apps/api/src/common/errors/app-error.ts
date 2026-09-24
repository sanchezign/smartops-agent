export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

/** Consistent JSON error shape returned by every endpoint. */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Typed, expected error. Its message is always safe to send to the client. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message = "Bad request", details?: unknown) =>
    new AppError(400, "BAD_REQUEST", message, details),
  validation: (details: unknown, message = "Request validation failed") =>
    new AppError(400, "VALIDATION_ERROR", message, details),
  unauthorized: (message = "Unauthorized") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Forbidden") => new AppError(403, "FORBIDDEN", message),
  notFound: (message = "Resource not found") => new AppError(404, "NOT_FOUND", message),
  conflict: (message = "Resource already exists", details?: unknown) =>
    new AppError(409, "CONFLICT", message, details),
  rateLimited: (message = "Too many requests, try again later") =>
    new AppError(429, "RATE_LIMITED", message),
  serviceUnavailable: (message = "Service unavailable") =>
    new AppError(503, "SERVICE_UNAVAILABLE", message),
};
