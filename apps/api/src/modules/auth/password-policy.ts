import { createHash } from "node:crypto";
import { COMMON_PASSWORD_SHA256 } from "./common-passwords.js";
import { normalizePassword } from "./password.js";

/**
 * Password policy (phase 8, ADR-018) — OWASP Authentication Cheat Sheet / NIST SP 800-63B:
 * - length 15–128 characters (no MFA yet → 15 minimum; ≥ 64 maximum allows passphrases);
 * - NO composition rules; any Unicode character and spaces allowed (NFKC-normalized);
 * - blocked: common / breached passwords (offline list, see common-passwords.ts), trivial
 *   patterns (one repeated character, a repeated short chunk, a keyboard/number sequence),
 *   and passwords containing the user's email local part, name or the product name.
 * Returns the reasons (codes) so the panel can explain them; empty = accepted.
 */

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordIssue =
  "too_short" | "too_long" | "common" | "trivial_pattern" | "contains_personal_info";

const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiopasdfghjklzxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm",
];

function isSequence(value: string): boolean {
  const lower = value.toLowerCase();
  return SEQUENCES.some((seq) => {
    const doubled = seq + seq;
    const reversed = [...doubled].reverse().join("");
    return doubled.includes(lower) || reversed.includes(lower);
  });
}

/** Whole value made of one chunk (1–4 chars) repeated: "aaaaaaaa…", "abcabcabc…". */
function isRepeatedChunk(value: string): boolean {
  return /^(.{1,4})\1+$/u.test(value);
}

export function checkPassword(
  password: string,
  context: { email?: string | null; name?: string | null } = {},
): PasswordIssue[] {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  const issues: PasswordIssue[] = [];
  if (length < PASSWORD_MIN_LENGTH) issues.push("too_short");
  if (length > PASSWORD_MAX_LENGTH) issues.push("too_long");

  const lower = normalized.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (COMMON_PASSWORD_SHA256.has(createHash("sha256").update(lower).digest("hex")))
    issues.push("common");
  if (compact.length > 0 && (isRepeatedChunk(compact) || isSequence(compact)))
    issues.push("trivial_pattern");

  const personal = [context.email?.split("@")[0], ...(context.name ?? "").split(/\s+/), "smartops"]
    .map((part) => part?.toLowerCase().trim() ?? "")
    .filter((part) => part.length >= 4);
  if (personal.some((part) => compact.includes(part.replace(/\s+/g, ""))))
    issues.push("contains_personal_info");
  return issues;
}

/**
 * English explanation for the CLI and the API error message (phase 13). The panel shows its
 * own text in the panel language from the `code` of each validation detail.
 */
export const PASSWORD_ISSUE_TEXT: Record<PasswordIssue, string> = {
  too_short: `At least ${PASSWORD_MIN_LENGTH} characters (a phrase of several words is ideal).`,
  too_long: `At most ${PASSWORD_MAX_LENGTH} characters.`,
  common: "It is a known or leaked password: choose another one.",
  trivial_pattern: "It is a trivial pattern (repetitions or keyboard / number sequences).",
  contains_personal_info: "It cannot contain your email, your name or the system's name.",
};
