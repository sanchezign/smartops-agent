import { readdirSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createLogger, type Logger } from "../../src/common/logger.js";
import type { Env } from "../../src/config/env.js";

/**
 * A logger built by the PRODUCTION factory (same redaction, same serializers) whose JSON
 * lines are kept in memory, for the log-safety tests (phase 10 M6, user addendum C).
 */
export function createCaptureLogger(
  env: Pick<Env, "NODE_ENV"> = { NODE_ENV: "test" },
  service: "api" | "worker" = "api",
): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line);
      done();
    },
  });
  return {
    logger: createLogger({ LOG_LEVEL: "trace", NODE_ENV: env.NODE_ENV }, service, sink),
    lines,
  };
}

const FIXTURES = new URL("../fixtures/whatsapp/", import.meta.url);

/**
 * Every PERSONAL identifier in the WhatsApp fixtures: phones, BSUIDs, media URLs, texts.
 * (`phone_number_id` is our business account id, not a person's number.)
 *
 * Every phone / BSUID / media URL / message text that appears in the WhatsApp fixtures. */
export function sensitiveFixtureValues(): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key = "") => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
      return;
    }
    if (typeof v !== "string") return;
    if (
      /^\+?\d{8,}$/.test(v) &&
      key !== "phone_number_id" &&
      /wa_id|from|to|recipient|phone|display/.test(key)
    )
      out.add(v.replace("+", ""));
    if (/user_id|recipient_user_id|from_user_id/.test(key) && v.length > 6) out.add(v);
    if (key === "url" && v.startsWith("http")) out.add(v);
    if (key === "body" && v.length > 3) out.add(v);
    if (key === "caption" && v.length > 3) out.add(v);
  };
  for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith(".json")))
    walk(JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")));
  return [...out];
}

/** 10–15 digit runs found in the string values of JSON log lines. */
export function digitRunsInStrings(lines: string[]): string[] {
  const found: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
      return;
    }
    // Meta's "timestamp" is Unix seconds as a string (10 digits), not a phone.
    if (typeof v === "string" && key !== "timestamp")
      found.push(...(v.match(/(?<![\w.-])\+?\d{10,15}(?![\w.-])/g) ?? []));
  };
  for (const line of lines) walk(JSON.parse(line));
  return found;
}
