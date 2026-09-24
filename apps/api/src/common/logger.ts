import { pino, type Logger } from "pino";
import type { Env } from "../config/env.js";

/** Headers that must never reach the logs. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-internal-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(
  env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">,
  service: "api" | "worker" = "api",
): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

export type { Logger };
