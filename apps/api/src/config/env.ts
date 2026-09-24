import { z } from "zod";

/**
 * Central env module — the ONLY place that reads process.env in the API.
 * `parseEnv` is pure (testable); `loadEnv` fails fast on startup.
 */

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const corsOrigins = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z.array(
      z
        .string()
        .refine((origin) => origin !== "*", {
          message: 'wildcard "*" is not allowed; list explicit origins',
        })
        .refine(isOrigin, {
          message: "must be an origin like https://admin.example.com (no path)",
        }),
    ),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// connection string"),
  CORS_ORIGINS: corsOrigins,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // ─── WhatsApp Business Cloud API (Meta) ───
  WHATSAPP_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like "v26.0"')
    .default("v26.0"),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, "must be the numeric Phone Number ID"),
  WHATSAPP_WABA_ID: z.string().regex(/^\d+$/, "must be the numeric WhatsApp Business Account ID"),
  WHATSAPP_ACCESS_TOKEN: z.string().min(20, "must be a Meta access token"),
  WHATSAPP_APP_SECRET: z.string().min(16, "must be the App Secret (App settings → Basic)"),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16, "use a random string of at least 16 characters"),
  WHATSAPP_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Per-IP limit for the webhook endpoint (separate from the global /api/v1 limit). */
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Cross-field rules, evaluated on the raw source so they are reported together
 * with field errors (a Zod superRefine is skipped when any field is invalid).
 */
function crossFieldIssues(source: Record<string, string | undefined>): string[] {
  const issues: string[] = [];
  if (source.NODE_ENV === "production" && !source.CORS_ORIGINS?.replaceAll(",", "").trim()) {
    issues.push("CORS_ORIGINS: is required in production");
  }
  return issues;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment variables:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  const issues = [
    ...(result.success
      ? []
      : result.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        )),
    ...crossFieldIssues(source),
  ];
  if (!result.success || issues.length > 0) {
    throw new EnvValidationError(issues);
  }
  return result.data;
}

/** Parses process.env; prints every problem and exits with code 1 if invalid. */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // The logger depends on the env, so write directly to stderr here.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}
