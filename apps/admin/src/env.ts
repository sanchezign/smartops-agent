import { z } from "zod";

/**
 * The ONLY entry point for environment variables in the panel (phase 8).
 * - NEXT_PUBLIC_API_BASE: where the browser calls the API. Default "/api/v1" = SAME ORIGIN
 *   (deploy option D: Caddy routes /api to the API; locally, next.config rewrites /api).
 * - API_PROXY_TARGET (server only): the API origin the local rewrite forwards to.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_API_BASE: z
    .string()
    .regex(/^(\/|https?:\/\/)[^\s]*$/, "a path like /api/v1 or an absolute URL")
    .default("/api/v1")
    .transform((v) => v.replace(/\/+$/, "")),
});

const serverSchema = z.object({
  API_PROXY_TARGET: z
    .string()
    .regex(/^https?:\/\/[^/\s]+$/, "an origin like http://localhost:4000 (no path)")
    .optional(),
});

// NEXT_PUBLIC_* must be referenced literally so Next inlines them in the browser bundle.
export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || undefined,
});

/** In development the rewrite targets the local API unless told otherwise. */
export function serverEnv() {
  const fallback = process.env.NODE_ENV === "production" ? undefined : "http://localhost:4000";
  return serverSchema.parse({ API_PROXY_TARGET: process.env.API_PROXY_TARGET || fallback });
}
