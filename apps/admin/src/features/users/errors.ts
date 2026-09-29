import { ApiError } from "@/lib/api-client";

export type UserErrorKey =
  "lastAdmin" | "emailTaken" | "ownRole" | "invalid" | "withCode" | "noCode" | "generic";

/**
 * User-management errors → a "users.errors" key (phase 9 M6; keys since phase 13). Pure.
 * `details` are the API's validation messages (the password policy), shown as they are.
 */
export function userErrorKey(error: unknown): {
  key: UserErrorKey;
  params?: Record<string, string>;
  details?: string[];
} {
  if (!(error instanceof ApiError)) return { key: "generic" };
  if (error.code === "CONFLICT" && /last active admin/i.test(error.message))
    return { key: "lastAdmin" };
  if (error.code === "CONFLICT" && /email/i.test(error.message)) return { key: "emailTaken" };
  if (error.code === "FORBIDDEN") return { key: "ownRole" };
  if (error.code === "VALIDATION_ERROR") {
    const details = Array.isArray(error.details) ? (error.details as { message?: string }[]) : [];
    const messages = details.map((d) => d.message).filter((m): m is string => Boolean(m));
    return messages.length > 0 ? { key: "invalid", details: messages } : { key: "invalid" };
  }
  return error.requestId
    ? { key: "withCode", params: { requestId: error.requestId } }
    : { key: "noCode" };
}
