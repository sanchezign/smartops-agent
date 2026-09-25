import type { Logger } from "../../common/logger.js";
import type { IntegrationEventRepository } from "./integration-event.repository.js";

/**
 * Delivery of outbox events to n8n (phase 6, ADR-015).
 * - POST to the receiver webhook with the shared secret header (n8n Webhook node, Header
 *   Auth credential). 2xx → delivered. Anything else (n8n down, workflow not published →
 *   404, 5xx, timeout) throws → pg-boss retries with backoff (~24 h), then the DLQ marks
 *   the event failed + raises an alert.
 * - Watchdog: re-sends pending events whose job was lost, and delivered events whose
 *   message never got an ingestion run (n8n accepted but crashed) — a bounded number of times.
 * Delivery is at-least-once: everything n8n calls on the backend is idempotent.
 */

export const N8N_SECRET_HEADER = "x-smartops-secret";

export interface N8nClientConfig {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class N8nDeliveryError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "N8nDeliveryError";
  }
}

export function createN8nClient(config: N8nClientConfig) {
  const doFetch = config.fetch ?? fetch;
  return {
    async send(payload: unknown): Promise<void> {
      let response: Response;
      try {
        response = await doFetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json", [N8N_SECRET_HEADER]: config.secret },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new N8nDeliveryError(
          `n8n unreachable: ${err instanceof Error ? err.message : String(err)}`,
          null,
        );
      }
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 300);
        throw new N8nDeliveryError(`n8n answered ${response.status}: ${body}`, response.status);
      }
    },
  };
}
export type N8nClient = ReturnType<typeof createN8nClient>;

export function createN8nDeliveryService(deps: {
  repository: IntegrationEventRepository;
  client: N8nClient;
}) {
  return {
    async deliver(eventId: string, log: Logger): Promise<"delivered" | "skipped" | "missing"> {
      const event = await deps.repository.getForDelivery(eventId);
      if (!event) return "missing";
      if (event.status !== "pending") return "skipped"; // idempotent: already delivered/failed
      try {
        await deps.client.send(event.payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.repository.recordFailure(eventId, message);
        log.warn(
          {
            eventId,
            attempt: event.attempts + 1,
            status: err instanceof N8nDeliveryError ? err.httpStatus : null,
          },
          "n8n delivery failed (will retry)",
        );
        throw err;
      }
      await deps.repository.markDelivered(eventId);
      log.info({ eventId, type: event.type }, "event delivered to n8n");
      return "delivered";
    },
  };
}
export type N8nDeliveryService = ReturnType<typeof createN8nDeliveryService>;

export function createN8nWatchdog(deps: {
  repository: IntegrationEventRepository;
  enqueue: (eventId: string) => Promise<void>;
  /** Pending events untouched for this long have lost their job. */
  staleMs?: number;
  /** Delivered but no ingestion run after this long → n8n never processed it. */
  processingGraceMs?: number;
  maxRedeliveries?: number;
  batchSize?: number;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const staleMs = deps.staleMs ?? 2 * 60 * 60 * 1000;
  const graceMs = deps.processingGraceMs ?? 15 * 60 * 1000;
  const maxRedeliveries = deps.maxRedeliveries ?? 2;
  const batchSize = deps.batchSize ?? 100;
  return {
    async run(log: Logger): Promise<{ stale: number; redelivered: number }> {
      const t = now().getTime();
      const stale = await deps.repository.findStalePending(new Date(t - staleMs), batchSize);
      await deps.repository.requeue(stale, { redelivery: false, resetAttempts: false });
      const unprocessed = await deps.repository.findDeliveredWithoutRun(
        new Date(t - graceMs),
        maxRedeliveries,
        batchSize,
      );
      await deps.repository.requeue(unprocessed, { redelivery: true, resetAttempts: true });
      for (const id of [...stale, ...unprocessed]) await deps.enqueue(id);
      if (stale.length + unprocessed.length > 0) {
        log.warn(
          { stale: stale.length, redelivered: unprocessed.length },
          "n8n watchdog re-sent events",
        );
      }
      return { stale: stale.length, redelivered: unprocessed.length };
    },
  };
}
