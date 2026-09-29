import type { Messages } from "next-intl";
import { z } from "zod";

/**
 * Login form. The password policy lives in the API: here only "not empty". Validation messages
 * are keys of "auth.validation" (phase 13): the form translates them.
 */
export const loginSchema = z.object({
  email: z.email("invalidEmail").max(254),
  password: z.string().min(1, "passwordRequired").max(1024),
});
export type LoginInput = z.infer<typeof loginSchema>;

export type LoginValidationKey = keyof Messages["auth"]["validation"];
export type LoginErrorKey = keyof Messages["auth"]["errors"];

export function isLoginValidationKey(value: unknown): value is LoginValidationKey {
  return value === "invalidEmail" || value === "passwordRequired" || value === "checkFields";
}

/** API error code → message key for the person (the API messages are for logs, in English). */
export function loginErrorKey(code: string): LoginErrorKey {
  switch (code) {
    case "UNAUTHORIZED":
      return "invalidCredentials";
    case "RATE_LIMITED":
      return "rateLimited";
    case "FORBIDDEN":
      return "rejected";
    default:
      return "unknown";
  }
}
