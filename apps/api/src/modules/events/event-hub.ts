import type { Logger } from "../../common/logger.js";
import { eventKey, type PanelEvent } from "./panel-events.js";

/**
 * In-memory fan-out of panel events to the SSE connections of THIS API process (ADR-020).
 * One Postgres LISTEN connection per process feeds it (pg-listener.ts); browsers never get a
 * database connection of their own. Caps: per user and in total. Events are coalesced per
 * subscriber for `flushMs` (a bulk ingest → a handful of events, duplicates sent once).
 */

export type HubMessage =
  | { kind: "events"; events: PanelEvent[] }
  /** The listener reconnected: events may have been lost → clients refetch everything. */
  | { kind: "resync" };

export interface Subscriber {
  userId: string;
  /**
   * What the per-user cap counts (default: the user id). The shared public demo account
   * counts per IP instead (phase 12): its visitors are different people.
   */
  limitKey?: string;
  send(message: HubMessage): void;
  /** Ends the stream (shutdown): the browser reconnects to another / the restarted process. */
  end(): void;
}

export interface EventHub {
  /** Throws TooManyStreamsError when a cap is reached. */
  subscribe(subscriber: Subscriber): () => void;
  publish(event: PanelEvent): void;
  resync(): void;
  stats(): { total: number; users: number };
  close(): void;
}

export class TooManyStreamsError extends Error {
  constructor(readonly scope: "user" | "total") {
    super(`too many event streams (${scope})`);
    this.name = "TooManyStreamsError";
  }
}

interface Entry {
  subscriber: Subscriber;
  pending: Map<string, PanelEvent>;
}

export function createEventHub(options: {
  maxPerUser: number;
  maxTotal: number;
  flushMs: number;
  logger: Logger;
}): EventHub {
  const entries = new Set<Entry>();
  const perUser = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function deliver(entry: Entry, message: HubMessage) {
    try {
      entry.subscriber.send(message);
    } catch (err) {
      // A broken socket must never stop the fan-out to the others.
      options.logger.warn({ err }, "event stream send failed");
    }
  }

  function flush() {
    timer = null;
    for (const entry of entries) {
      if (entry.pending.size === 0) continue;
      const events = [...entry.pending.values()];
      entry.pending.clear();
      deliver(entry, { kind: "events", events });
    }
  }

  return {
    subscribe(subscriber) {
      if (entries.size >= options.maxTotal) throw new TooManyStreamsError("total");
      const limitKey = subscriber.limitKey ?? subscriber.userId;
      const count = perUser.get(limitKey) ?? 0;
      if (count >= options.maxPerUser) throw new TooManyStreamsError("user");
      const entry: Entry = { subscriber, pending: new Map() };
      entries.add(entry);
      perUser.set(limitKey, count + 1);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entries.delete(entry);
        const left = (perUser.get(limitKey) ?? 1) - 1;
        if (left <= 0) perUser.delete(limitKey);
        else perUser.set(limitKey, left);
      };
    },

    publish(event) {
      if (entries.size === 0) return;
      const key = eventKey(event);
      for (const entry of entries) entry.pending.set(key, event);
      timer ??= setTimeout(flush, options.flushMs);
    },

    resync() {
      for (const entry of entries) {
        entry.pending.clear();
        deliver(entry, { kind: "resync" });
      }
    },

    stats() {
      return { total: entries.size, users: perUser.size };
    },

    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const entry of [...entries]) {
        try {
          entry.subscriber.end();
        } catch {
          // already closed
        }
      }
      entries.clear();
      perUser.clear();
    },
  };
}
