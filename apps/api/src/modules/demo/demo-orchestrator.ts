import type { Logger } from "../../common/logger.js";
import { messageReadyPayloadSchema } from "../integration/message-ready.js";
import { N8nDeliveryError, type N8nClient } from "../integration/n8n-delivery.js";

/**
 * In-process stand-in for the three n8n workflows (ADR-025, DEMO_MODE only), for a demo that must
 * fit a 1 GB VM. It does what the exported workflows do — receiver → processor → notifier — over
 * the SAME internal API, with the same steps: classify, route by classification, extract, wait
 * while "extracting" (10 s, at most 30 times), ingest, notify, supplier ack; each call retried
 * 3 times 5 s apart; a failure is reported to `/internal/n8n/errors` like the error workflow.
 * `test/unit/orchestrator-parity.test.ts` runs the exported workflows and this code side by
 * side and fails if they ever make different calls.
 */

export type InternalCall = (
  method: "GET" | "POST",
  path: string,
  body?: object,
) => Promise<Record<string, unknown>>;

export class InternalCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "InternalCallError";
  }
}

/** HTTP caller of `/api/v1/internal/*` (X-Internal-Api-Key). */
export function createInternalApiCaller(config: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): InternalCall {
  const doFetch = config.fetch ?? fetch;
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await doFetch(`${config.baseUrl.replace(/\/+$/, "")}/api/v1/internal${path}`, {
        method,
        headers: { "content-type": "application/json", "x-internal-api-key": config.apiKey },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new InternalCallError(
        `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = (json.error as { message?: string } | undefined)?.message ?? "request failed";
      throw new InternalCallError(`${method} ${path}: ${res.status} ${message}`, res.status);
    }
    return json;
  };
}

export interface OrchestratorOptions {
  call: InternalCall;
  logger: Pick<Logger, "info" | "warn" | "error">;
  sleep?: (ms: number) => Promise<void>;
  /** n8n HTTP nodes: retryOnFail, 3 tries, 5 s apart. */
  retry?: { tries: number; waitMs: number };
  /** n8n "Esperar 10 s" and the `$runIndex < 30` guard of the processor. */
  poll?: { waitMs: number; max: number };
}

const WORKFLOW = {
  receiver: "SmartOps · Receptor",
  processor: "SmartOps · Procesador",
  notifier: "SmartOps · Notificador",
} as const;

/** An error already reported by the workflow that raised it (not reported again by its caller). */
class ReportedError extends Error {}

export function createOrchestrator(options: OrchestratorOptions) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retry = options.retry ?? { tries: 3, waitMs: 5_000 };
  const poll = options.poll ?? { waitMs: 10_000, max: 30 };
  let executions = 0;

  /** One HTTP Request node: retried like n8n's retryOnFail. */
  async function http(method: "GET" | "POST", path: string, body?: object) {
    let last: unknown;
    for (let attempt = 1; attempt <= retry.tries; attempt += 1) {
      try {
        return await options.call(method, path, body);
      } catch (err) {
        last = err;
        if (attempt < retry.tries) await sleep(retry.waitMs);
      }
    }
    throw last;
  }

  async function inWorkflow<T>(workflow: string, executionId: string, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReportedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      options.logger.warn({ workflow, executionId }, "orchestrator workflow failed");
      // The error workflow: a critical alert + notification in the backend (best effort).
      await options
        .call("POST", "/n8n/errors", {
          workflow,
          executionId,
          message: message.slice(0, 2_000) || "unknown error",
        })
        .catch((e: unknown) => options.logger.error({ err: e }, "could not report the error"));
      throw new ReportedError(message);
    }
  }

  async function notifier(
    input: { kind: "run"; runId: string } | { kind: string; messageId: string },
  ) {
    await inWorkflow(WORKFLOW.notifier, String(++executions), async () => {
      await http("POST", "/notifications", input);
      if (input.kind === "run")
        await http("POST", "/messages/ack", { runId: (input as { runId: string }).runId });
    });
  }

  async function processor(runId: string) {
    await inWorkflow(WORKFLOW.processor, String(++executions), async () => {
      let state = await http("POST", "/extract", { runId });
      for (let runIndex = 0; ; runIndex += 1) {
        if (state.status === "extracted") {
          await http("POST", "/catalog/ingest", { runId });
          break;
        }
        if (state.status === "extracting" && runIndex < poll.max) {
          await sleep(poll.waitMs);
          state = await http("GET", `/runs/${runId}`);
          continue;
        }
        break; // neither: the workflow notifies anyway (the run has its own report)
      }
    });
    await notifier({ kind: "run", runId });
  }

  return {
    /** The receiver workflow, for one `message.ready` event. */
    async handle(event: { messageId: string }): Promise<void> {
      try {
        await inWorkflow(WORKFLOW.receiver, String(++executions), async () => {
          const classified = await http("POST", "/classify", { messageId: event.messageId });
          const cls = (classified.classification as string | null | undefined) ?? null;
          if (cls === null || cls === "price_list_full" || cls === "price_update_partial") {
            const runId = classified.runId as string | undefined;
            if (!runId) throw new Error("classify answered without a runId");
            await processor(runId);
          } else if (cls === "customer_query") {
            await notifier({ kind: "customer_query", messageId: event.messageId });
          } else if (cls === "internal_order") {
            await notifier({ kind: "order", messageId: event.messageId });
          }
        });
      } catch (err) {
        if (!(err instanceof ReportedError)) throw err; // already reported: nothing else to do
      }
    },
  };
}
export type Orchestrator = ReturnType<typeof createOrchestrator>;

/**
 * Samples go through ONE AT A TIME (user, 2026-10-02): several visitors at once must not
 * saturate 1/8 of a CPU. A bounded FIFO: when full, `push` refuses and the outbox retries later.
 */
export function createSerialQueue(options: { max: number }) {
  const pending: (() => Promise<void>)[] = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (let task = pending.shift(); task; task = pending.shift()) await task();
    } finally {
      running = false;
    }
  }

  return {
    push(task: () => Promise<void>): boolean {
      if (pending.length >= options.max) return false;
      pending.push(task);
      void drain();
      return true;
    },
    get size() {
      return pending.length + (running ? 1 : 0);
    },
  };
}

/** Drop-in for `createN8nClient`: accepts the event at once (like n8n's "respond immediately"). */
export function createOrchestratorClient(deps: {
  orchestrator: Orchestrator;
  logger: Pick<Logger, "error">;
  maxQueue?: number;
}): N8nClient {
  const queue = createSerialQueue({ max: deps.maxQueue ?? 50 });
  return {
    async send(payload: unknown): Promise<void> {
      const parsed = messageReadyPayloadSchema.safeParse(payload);
      if (!parsed.success) throw new N8nDeliveryError("invalid message.ready payload", 400);
      const event = { messageId: parsed.data.messageId };
      const accepted = queue.push(() =>
        deps.orchestrator.handle(event).catch((err: unknown) => {
          deps.logger.error({ err }, "orchestrator failed");
        }),
      );
      if (!accepted) throw new N8nDeliveryError("orchestrator queue is full", 429);
    },
  };
}
