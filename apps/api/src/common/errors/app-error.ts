export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  /** The resource exists but is not ready yet (e.g. media still downloading). Retry later. */
  | "NOT_READY"
  /** Another request is processing the same resource right now (lock held). */
  | "IN_PROGRESS"
  /** Human review: the proposal is obsolete (the product changed since); it is superseded. */
  | "STALE_REVIEW"
  /** WhatsApp: free-form message outside the 24h customer service window (send a template). */
  | "WINDOW_CLOSED"
  /** WhatsApp: business-initiated message to a contact without opt-in (ADR-009). */
  | "OPT_IN_REQUIRED"
  /** WhatsApp: automatic reply while a person handles the conversation (ADR-016). */
  | "HUMAN_MODE"
  /** WhatsApp: business-initiated message to a contact who opted out (ADR-017). */
  | "OPTED_OUT"
  /** Panel auth: two tabs refreshed with the same cookie at once — retry (ADR-018). */
  | "REFRESH_RACE"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  /** Panel real time: too many open event streams for this user (ADR-020). */
  | "TOO_MANY_STREAMS"
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
  notReady: (message: string, details?: unknown) =>
    new AppError(409, "NOT_READY", message, details),
  inProgress: (message: string, details?: unknown) =>
    new AppError(409, "IN_PROGRESS", message, details),
  staleReview: (message: string, details?: unknown) =>
    new AppError(409, "STALE_REVIEW", message, details),
  windowClosed: (
    details: unknown,
    message = "Outside the 24h customer service window: send an approved template",
  ) => new AppError(409, "WINDOW_CLOSED", message, details),
  optInRequired: (
    details: unknown,
    message = "The contact has not opted in to receive business-initiated messages",
  ) => new AppError(409, "OPT_IN_REQUIRED", message, details),
  humanMode: (
    details: unknown,
    message = "A person is handling this conversation: automatic replies are paused",
  ) => new AppError(409, "HUMAN_MODE", message, details),
  optedOut: (details: unknown, message = "The contact opted out of business-initiated messages") =>
    new AppError(409, "OPTED_OUT", message, details),
  refreshRace: (message = "Concurrent session refresh: retry") =>
    new AppError(409, "REFRESH_RACE", message),
  rateLimited: (message = "Too many requests, try again later") =>
    new AppError(429, "RATE_LIMITED", message),
  tooManyStreams: (message = "Too many open event streams for this user") =>
    new AppError(429, "TOO_MANY_STREAMS", message),
  serviceUnavailable: (message = "Service unavailable") =>
    new AppError(503, "SERVICE_UNAVAILABLE", message),
};
