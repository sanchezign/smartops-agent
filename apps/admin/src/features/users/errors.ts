import { ApiError } from "@/lib/api-client";

export type UserErrorKey =
  "lastAdmin" | "emailTaken" | "ownRole" | "invalid" | "withCode" | "noCode" | "generic";

/** Password-policy codes the API sends in the validation details ("users.passwordIssues"). */
export const PASSWORD_ISSUES = [
  "too_short",
  "too_long",
  "common",
  "trivial_pattern",
  "contains_personal_info",
] as const;
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number];

const isIssue = (code: unknown): code is PasswordIssue =>
  (PASSWORD_ISSUES as readonly unknown[]).includes(code);

/**
 * User-management errors → a "users.errors" key (phase 9 M6; keys since phase 13). Pure.
 * A policy violation comes back as `issues` (codes the panel translates); any other validation
 * detail is kept as the API's message in `details`.
 */
export function userErrorKey(error: unknown): {
  key: UserErrorKey;
  params?: Record<string, string>;
  issues?: PasswordIssue[];
  details?: string[];
} {
  if (!(error instanceof ApiError)) return { key: "generic" };
  if (error.code === "CONFLICT" && /last active admin/i.test(error.message))
    return { key: "lastAdmin" };
  if (error.code === "CONFLICT" && /email/i.test(error.message)) return { key: "emailTaken" };
  if (error.code === "FORBIDDEN") return { key: "ownRole" };
  if (error.code === "VALIDATION_ERROR") {
    const raw = Array.isArray(error.details)
      ? (error.details as { code?: unknown; message?: string }[])
      : [];
    const issues = raw.map((d) => d.code).filter(isIssue);
    const details = raw
      .filter((d) => !isIssue(d.code))
      .map((d) => d.message)
      .filter((m): m is string => Boolean(m));
    return {
      key: "invalid",
      ...(issues.length > 0 ? { issues } : {}),
      ...(details.length > 0 ? { details } : {}),
    };
  }
  return error.requestId
    ? { key: "withCode", params: { requestId: error.requestId } }
    : { key: "noCode" };
}
