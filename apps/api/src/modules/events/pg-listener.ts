import pg from "pg";
import type { Logger } from "../../common/logger.js";
import { PANEL_EVENTS_CHANNEL, parsePanelEvent, type PanelEvent } from "./panel-events.js";

/**
 * THE one Postgres connection per API process that LISTENs to panel events (ADR-020). A
 * dedicated client (LISTEN cannot live in a pool). If it drops, it reconnects with backoff and
 * reports `onReconnect` — notifications sent while it was down are lost, so the hub tells
 * every browser to refetch.
 */

export interface PgListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
}

export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  removeAllListeners(): unknown;
}

export function createPgListener(options: {
  connectionString: string;
  onEvent(event: PanelEvent): void;
  onReconnect(): void;
  logger: Logger;
  /** Tests inject a fake client. */
  createClient?: () => ListenClient;
  backoffMs?: (attempt: number) => number;
}): PgListener {
  const createClient =
    options.createClient ??
    (() =>
      new pg.Client({
        connectionString: options.connectionString,
        application_name: "smartops-api-events",
        keepAlive: true,
      }) as unknown as ListenClient);
  const backoff = options.backoffMs ?? ((n: number) => Math.min(30_000, 1_000 * 2 ** n));
  const log = options.logger.child({ component: "pg-listener" });

  let client: ListenClient | null = null;
  let stopped = false;
  let isConnected = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = createClient();
    client = c;
    c.on("notification", (msg) => {
      if (msg.channel !== PANEL_EVENTS_CHANNEL) return;
      const event = parsePanelEvent(msg.payload);
      if (!event) {
        log.warn({ bytes: msg.payload?.length ?? 0 }, "unknown panel event dropped");
        return;
      }
      options.onEvent(event);
    });
    const lost = (reason: string, err?: Error) => {
      if (client !== c) return;
      isConnected = false;
      client = null;
      c.removeAllListeners();
      void c.end().catch(() => undefined);
      if (stopped) return;
      const delay = backoff(attempt);
      attempt += 1;
      log.warn({ err, reason, retryInMs: delay }, "event listener connection lost");
      retryTimer = setTimeout(() => void connect(), delay);
    };
    c.on("error", (err) => lost("error", err));
    c.on("end", () => lost("end"));
    try {
      await c.connect();
      await c.query(`LISTEN ${PANEL_EVENTS_CHANNEL}`);
      isConnected = true;
      attempt = 0;
      log.info("listening to panel events");
      if (everConnected) options.onReconnect();
      everConnected = true;
    } catch (err) {
      lost("connect_failed", err as Error);
    }
  }

  return {
    async start() {
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const c = client;
      client = null;
      isConnected = false;
      if (c) {
        c.removeAllListeners();
        await c.end().catch(() => undefined);
      }
    },
    connected: () => isConnected,
  };
}
