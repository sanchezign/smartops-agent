import { z } from "zod";

/**
 * Central env module — the ONLY place that reads process.env in the API.
 * `parseEnv` is pure (testable); `loadEnv` fails fast on startup.
 */

/** The only Graph API host allowed in production (the fake Graph API is for local dev). */
export const META_GRAPH_BASE_URL = "https://graph.facebook.com";

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
  /** Graph API host. Local dev may point it at the fake Graph API (wa:fake-graph). */
  WHATSAPP_GRAPH_BASE_URL: z
    .string()
    .default(META_GRAPH_BASE_URL)
    .refine(isBaseUrl, {
      message: "must be an http(s) URL without path, e.g. http://localhost:4010",
    })
    .transform((url) => url.replace(/\/+$/, "")),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, "must be the numeric Phone Number ID"),
  WHATSAPP_WABA_ID: z.string().regex(/^\d+$/, "must be the numeric WhatsApp Business Account ID"),
  WHATSAPP_ACCESS_TOKEN: z.string().min(20, "must be a Meta access token"),
  WHATSAPP_APP_SECRET: z.string().min(16, "must be the App Secret (App settings → Basic)"),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16, "use a random string of at least 16 characters"),
  WHATSAPP_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Per-IP limit for the webhook endpoint (separate from the global /api/v1 limit). */
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  // ─── Worker (pg-boss) ───
  /** Parallel webhook-processing jobs per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

  // ─── Media (ADR-008) ───
  /** Own cap on downloaded media, on top of Meta limits (default 25 MB). */
  MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  MEDIA_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Parallel media downloads per worker process (each buffers up to MEDIA_MAX_BYTES). */
  MEDIA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),

  // ─── Outbound messages ───
  /** Parallel outbound sends per worker (order per conversation is kept by the queue). */
  OUTBOUND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

  // ─── Speech-to-text (ADR-005, ADR-010) ───
  /** groq (default choice, free plan) | openai | fake (dev/tests/demo; forbidden in production). */
  TRANSCRIPTION_PROVIDER: z.enum(["groq", "openai", "fake"]).default("fake"),
  /** Required unless the provider is fake. */
  TRANSCRIPTION_API_KEY: optionalString(z.string().min(10, "must be the provider API key")),
  /** OpenAI-compatible base URL; defaults per provider (Groq: https://api.groq.com/openai/v1). */
  TRANSCRIPTION_BASE_URL: optionalString(
    z
      .string()
      .refine(isHttpUrl, { message: "must be an http(s) URL" })
      .transform((url) => url.replace(/\/+$/, "")),
  ),
  /** Defaults per provider (Groq: whisper-large-v3). */
  TRANSCRIPTION_MODEL: optionalString(z.string().min(1)),
  /** ISO-639-1 language hint sent to Whisper. */
  TRANSCRIPTION_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}$/, 'ISO-639-1 code, e.g. "es"')
    .default("es"),
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Fake provider: transcripts registered by `wa:simulate audio --transcript`. */
  TRANSCRIPTION_FAKE_DIR: z.string().min(1).default(".sim/transcripts"),
  /** Parallel transcriptions per worker (Groq free plan: 20 req/min). */
  TRANSCRIPTION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  /** Max transcriptions per contact in a rolling 24h window (protects the free quota). */
  TRANSCRIPTION_DAILY_LIMIT_PER_CONTACT: z.coerce.number().int().min(1).default(50),

  // ─── Internal API for n8n (/api/v1/internal/*) ───
  /** Shared secret sent by n8n in X-Internal-Api-Key. Never exposed to the frontend. */
  INTERNAL_API_KEY: z.string().min(32, "must be a random secret of at least 32 characters"),
  /** Per-IP rate limit for /api/v1/internal (per RATE_LIMIT_WINDOW_MS). */
  INTERNAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  // ─── Panel auth (phase 8, ADR-018) ───
  /** HS256 key for access tokens (API only). Random, ≥ 32 characters; rotating it logs everyone out. */
  JWT_ACCESS_SECRET: z.string().min(32, "must be a random secret of at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  /** A session without a refresh for this long ends (idle timeout). */
  SESSION_IDLE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  /** Absolute session lifetime, whatever the activity. */
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /**
   * Refresh cookie. strict = same origin (option D, VM + Caddy; option A, Vercel rewrite);
   * lax = same site (own domain); none = cross-site (needs Secure; add PARTITIONED for Safari).
   */
  AUTH_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  /** auto = Secure in production (HTTPS), not in local http dev. */
  AUTH_COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  AUTH_COOKIE_PARTITIONED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Per-IP login attempts per 15 minutes (on top of the per-account lockout). */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

  // ─── Panel real time (phase 9 M4, ADR-020) ───
  /** Open event streams per user (tabs + phone); more → 429 TOO_MANY_STREAMS. */
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().min(1).max(50).default(5),
  /** Open event streams per API process. */
  SSE_MAX_STREAMS: z.coerce.number().int().min(1).max(10_000).default(500),
  /** Heartbeat: keeps proxies from closing the stream and re-checks the session. */
  SSE_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  /**
   * Public URL of the panel (phase 9 M7): WhatsApp digests end with PANEL_PUBLIC_URL/d/<token>.
   * Unset → no link. HTTPS required in production.
   */
  PANEL_PUBLIC_URL: optionalString(
    z
      .string()
      .refine(isHttpUrl, { message: "must be an http(s) URL" })
      .transform((url) => url.replace(/\/+$/, "")),
  ),

  // ─── Public demo (phase 9 M8, ADR-021) ───
  /**
   * DEMO_MODE: the public $0 demo. FORCES the fake LLM and transcriber, points the WhatsApp
   * Graph client at the fake Graph API served by this API (never Meta), enables /api/v1/demo/*
   * and the "Probar el sistema" page, and requires a *_demo database.
   */
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Where the worker reaches the API's fake Graph API (default http://127.0.0.1:PORT). */
  DEMO_GRAPH_URL: optionalString(
    z.string().refine(isBaseUrl, { message: "must be an http(s) URL without path" }),
  ),
  /** Demo data is reset automatically every N minutes (0 = never; "Reiniciar demo" always works). */
  DEMO_RESET_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  /** Demo buttons per IP per 10 minutes. */
  DEMO_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(20),
  /** Demo buttons per hour for ALL visitors together (phase 12: the operator is public). */
  DEMO_GLOBAL_INJECT_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(120),
  /** Demo assets (sample files, recorded LLM outputs, transcripts), relative to the API package. */
  DEMO_ASSETS_DIR: z.string().min(1).default("demo"),
  /** E2E only: the seed adds one review per Playwright project to approve / reject. */
  DEMO_E2E_REVIEWS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ─── Demo data (phase 9) ───
  /** Separate demo database (name MUST end in "_demo"): demo:seed / demo:reset. */
  DEMO_DATABASE_URL: optionalString(
    z.string().regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// connection string"),
  ),
  /** Demo operator: PUBLIC credentials by design (shown on the login screen in DEMO_MODE). */
  DEMO_OPERATOR_EMAIL: z.string().email().default("demo@ferreteria.demo"),
  DEMO_OPERATOR_PASSWORD: z.string().min(15).default("probá el panel sin miedo"),
  /** Demo admin: only created when a password is given (no default admin password). */
  DEMO_ADMIN_EMAIL: z.string().email().default("admin@ferreteria.demo"),
  DEMO_ADMIN_PASSWORD: optionalString(z.string().min(15)),

  // ─── n8n (phase 6, ADR-015) ───
  /** Deliver "message.ready" events to n8n. Off: events accumulate and go out when enabled. */
  N8N_DELIVERY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** n8n receiver webhook (production URL: the workflow must be published). */
  N8N_RECEIVER_WEBHOOK_URL: z
    .string()
    .url()
    .default("http://localhost:5678/webhook/smartops-message-ready"),
  /** Shared secret checked by the n8n Webhook node (Header Auth, X-SmartOps-Secret). */
  N8N_WEBHOOK_SECRET: optionalString(
    z.string().min(32, "must be a random secret of at least 32 characters"),
  ),

  // ─── Document conversion (xlsx/xls/csv/txt/docx → text, ADR-013) ───
  DOC_CONVERT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  DOC_CONVERT_MAX_SHEETS: z.coerce.number().int().min(1).max(100).default(10),
  DOC_CONVERT_MAX_ROWS: z.coerce.number().int().min(1).max(100_000).default(2_000),
  DOC_CONVERT_MAX_COLUMNS: z.coerce.number().int().min(1).max(500).default(50),
  /** Max characters of the converted text (controls LLM input cost). */
  DOC_CONVERT_MAX_CHARS: z.coerce.number().int().min(1_000).default(40_000),
  /** The conversion runs in a worker thread killed after this time. */
  DOC_CONVERT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),
  DOC_CONVERT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),

  // ─── AI / LLM (ADR-011) ───
  /** anthropic | fake (default; dev/tests/CI/demo without a key; forbidden in production). */
  AI_PROVIDER: z.enum(["anthropic", "fake"]).default("fake"),
  /** Required when AI_PROVIDER=anthropic. */
  ANTHROPIC_API_KEY: optionalString(z.string().min(20, "must be an Anthropic API key")),
  AI_CLASSIFIER_MODEL: z.string().min(1).default("claude-sonnet-5"),
  AI_EXTRACTOR_MODEL: z.string().min(1).default("claude-sonnet-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Hard cap on total estimated AI spend (USD). The project has ~5 USD of credits. */
  AI_TOTAL_BUDGET_USD: z.coerce.number().positive().default(4),
  /** Hard cap per UTC day (USD). */
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.5),
  /** Hard cap per ingestion run = all AI calls for one message (USD). */
  AI_MAX_RUN_USD: z.coerce.number().positive().default(0.3),
  /** Max extractions per contact per UTC day. */
  AI_DAILY_LIMIT_PER_CONTACT: z.coerce.number().int().min(1).default(20),
  /** Prompt caching of system prompts (reads 0.1x, writes 1.25x of the input price). */
  AI_PROMPT_CACHE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Fake provider: recorded golden outputs (<dir>/<task>/<contentKey>.json). */
  AI_FAKE_GOLDEN_DIR: z.string().min(1).default("test/fixtures/extraction/golden"),
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
  const demo = source.DEMO_MODE === "true";
  if (demo) {
    // The demo resets its data: it must never run on a real database.
    const name = (() => {
      try {
        return decodeURIComponent(new URL(source.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
      } catch {
        return "";
      }
    })();
    if (!name.endsWith("_demo"))
      issues.push("DEMO_MODE: DATABASE_URL must point to a *_demo database");
    if (source.NODE_ENV === "production") issues.push(...publicDemoIssues(source));
  }
  if (
    !demo &&
    source.NODE_ENV === "production" &&
    source.WHATSAPP_GRAPH_BASE_URL !== undefined &&
    source.WHATSAPP_GRAPH_BASE_URL.replace(/\/+$/, "") !== META_GRAPH_BASE_URL
  ) {
    issues.push(`WHATSAPP_GRAPH_BASE_URL: must be ${META_GRAPH_BASE_URL} in production`);
  }
  if (
    source.NODE_ENV === "production" &&
    source.PANEL_PUBLIC_URL?.trim() &&
    !source.PANEL_PUBLIC_URL.trim().startsWith("https://")
  ) {
    issues.push("PANEL_PUBLIC_URL: must use https:// in production");
  }
  const provider = source.TRANSCRIPTION_PROVIDER ?? "fake";
  if (source.NODE_ENV === "production" && provider === "fake" && !demo) {
    issues.push("TRANSCRIPTION_PROVIDER: the fake provider is not allowed in production");
  }
  if (source.N8N_DELIVERY_ENABLED === "true" && !source.N8N_WEBHOOK_SECRET?.trim()) {
    issues.push("N8N_WEBHOOK_SECRET: is required when N8N_DELIVERY_ENABLED=true");
  }
  const aiProvider = source.AI_PROVIDER ?? "fake";
  if (source.NODE_ENV === "production" && aiProvider === "fake" && !demo) {
    issues.push("AI_PROVIDER: the fake provider is not allowed in production");
  }
  if (aiProvider === "anthropic" && !source.ANTHROPIC_API_KEY?.trim()) {
    issues.push("ANTHROPIC_API_KEY: is required when AI_PROVIDER=anthropic");
  }
  const daily = Number(source.AI_DAILY_BUDGET_USD ?? 0.5);
  const total = Number(source.AI_TOTAL_BUDGET_USD ?? 4);
  if (Number.isFinite(daily) && Number.isFinite(total) && daily > total) {
    issues.push("AI_DAILY_BUDGET_USD: must not exceed AI_TOTAL_BUDGET_USD");
  }
  const cookieSecure = source.AUTH_COOKIE_SECURE ?? "auto";
  const secureEffective =
    cookieSecure === "true" || (cookieSecure === "auto" && source.NODE_ENV === "production");
  if (source.NODE_ENV === "production" && cookieSecure === "false") {
    issues.push("AUTH_COOKIE_SECURE: cannot be false in production");
  }
  if (source.AUTH_COOKIE_SAMESITE === "none" && !secureEffective) {
    issues.push("AUTH_COOKIE_SAMESITE: none requires a Secure cookie (AUTH_COOKIE_SECURE=true)");
  }
  if (source.AUTH_COOKIE_PARTITIONED === "true" && !secureEffective) {
    issues.push("AUTH_COOKIE_PARTITIONED: requires a Secure cookie (AUTH_COOKIE_SECURE=true)");
  }
  if (provider !== "fake" && !source.TRANSCRIPTION_API_KEY?.trim()) {
    issues.push(`TRANSCRIPTION_API_KEY: is required when TRANSCRIPTION_PROVIDER=${provider}`);
  }
  return issues;
}

/**
 * The PUBLIC demo server (DEMO_MODE in production, phase 12) must not even HOLD a real key:
 * DEMO_MODE forces the fakes, but a key that is present can leak (a dump of the environment, a
 * future bug). No demo admin either: its password would be the only thing between a visitor
 * and the settings / users screens. Values are never echoed back.
 */
const REAL_KEY_PATTERNS: readonly [string, RegExp][] = [
  ["an Anthropic API key", /^sk-ant-/],
  ["a Groq API key", /^gsk_/],
  ["an OpenAI API key", /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/],
  ["a Meta access token", /^EAA[A-Za-z0-9]{20,}$/],
];

function publicDemoIssues(source: Record<string, string | undefined>): string[] {
  const issues: string[] = [];
  for (const key of ["ANTHROPIC_API_KEY", "TRANSCRIPTION_API_KEY"]) {
    if (source[key]?.trim()) issues.push(`${key}: must be empty on the public demo (DEMO_MODE)`);
  }
  if (source.DEMO_ADMIN_PASSWORD?.trim()) {
    issues.push("DEMO_ADMIN_PASSWORD: the public demo has no admin account (leave it unset)");
  }
  for (const [key, value] of Object.entries(source)) {
    const found = REAL_KEY_PATTERNS.find(([, pattern]) => value && pattern.test(value.trim()));
    if (found) issues.push(`${key}: looks like ${found[0]} — never on the public demo`);
  }
  return issues;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment variables:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * DEMO_MODE (phase 9 M8) is applied BEFORE validation, whatever the other variables say: fake
 * LLM + fake transcriber ($0), the fake Graph API of this API (no real WhatsApp can leave),
 * recorded outputs and transcripts from the demo assets.
 */
export function applyDemoMode(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (source.DEMO_MODE !== "true") return source;
  const assets = (source.DEMO_ASSETS_DIR ?? "demo").replace(/\/+$/, "");
  return {
    ...source,
    AI_PROVIDER: "fake",
    TRANSCRIPTION_PROVIDER: "fake",
    WHATSAPP_GRAPH_BASE_URL:
      source.DEMO_GRAPH_URL?.trim() || `http://127.0.0.1:${source.PORT ?? "4000"}`,
    AI_FAKE_GOLDEN_DIR: `${assets}/golden`,
    TRANSCRIPTION_FAKE_DIR: `${assets}/transcripts`,
  };
}

export function parseEnv(input: Record<string, string | undefined>): Env {
  const source = applyDemoMode(input);
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

function isBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Optional env var where an empty value (`KEY=`) means "not set". */
function optionalString<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}
