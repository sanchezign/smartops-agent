import type { Logger } from "../../common/logger.js";
import type { HealthRepository } from "./health.repository.js";

export interface HealthReport {
  status: "ok" | "error";
  db: "up" | "down";
  uptimeSeconds: number;
  timestamp: string;
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

export function createHealthService(deps: {
  repository: HealthRepository;
  logger: Logger;
  dbTimeoutMs?: number;
}): HealthService {
  const timeoutMs = deps.dbTimeoutMs ?? 2_000;

  return {
    async check() {
      let dbUp = true;
      try {
        await withTimeout(deps.repository.ping(), timeoutMs);
      } catch (err) {
        dbUp = false;
        deps.logger.warn({ err }, "health check: database unreachable");
      }
      return {
        status: dbUp ? "ok" : "error",
        db: dbUp ? "up" : "down",
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
