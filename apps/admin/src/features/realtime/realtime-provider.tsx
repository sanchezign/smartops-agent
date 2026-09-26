"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { api } from "@/features/auth/api";
import { ApiError } from "@/lib/api-client";
import { createSseParser } from "@/lib/sse";
import {
  backoffMs,
  keysFor,
  mergeKeys,
  type PanelEvent,
  type QueryKeyPrefix,
} from "./invalidation";
import { useRealtimeStore } from "./store";

const FLUSH_MS = 200;

/**
 * Keeps ONE event stream per tab (GET /api/v1/events, ADR-020) and turns events into query
 * invalidations. Reconnects with backoff; on every RE-connection (or a server "resync") every
 * query is refetched, since events may have been missed meanwhile. A "session" event (logout
 * elsewhere, expiry, role change) triggers a refresh: success → reconnect with the new token /
 * role; failure → signed out (the AuthGate sends the person to the login).
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const setStatus = useRealtimeStore.getState().setStatus;
    let stopped = false;
    let controller: AbortController | null = null;
    let wake: (() => void) | null = null;
    let hadConnection = false;
    let attempt = 0;
    const pending: QueryKeyPrefix[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (keys: QueryKeyPrefix[]) => {
      pending.push(...keys);
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        for (const key of mergeKeys(pending.splice(0))) {
          void queryClient.invalidateQueries({ queryKey: [...key] });
        }
      }, FLUSH_MS);
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });

    async function connectOnce(): Promise<string | null> {
      controller = new AbortController();
      let sessionEnd: string | null = null;
      const res = await api.stream("/events", {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      const parser = createSseParser({
        onFrame(frame) {
          if (frame.event === "ready") {
            setStatus("live");
            if (hadConnection) void queryClient.invalidateQueries();
            hadConnection = true;
            attempt = 0;
          } else if (frame.event === "events") {
            const events = JSON.parse(frame.data) as PanelEvent[];
            invalidate(events.flatMap(keysFor));
          } else if (frame.event === "resync") {
            void queryClient.invalidateQueries();
          } else if (frame.event === "session") {
            sessionEnd = (JSON.parse(frame.data) as { reason: string }).reason;
          }
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      return sessionEnd;
    }

    async function run() {
      while (!stopped) {
        let reason: string | null = null;
        try {
          reason = await connectOnce();
        } catch (err) {
          if (stopped) return;
          // 401 after the client's own refresh = the session is gone (AuthGate takes over).
          if (err instanceof ApiError && err.status === 401) return setStatus("offline");
          if (err instanceof ApiError && err.status === 429) attempt = Math.max(attempt, 4);
        }
        if (stopped) return;
        setStatus("offline");
        if (reason === "ended" || reason === "role_changed") {
          if (!(await api.refresh())) return;
          attempt = 0;
          continue;
        }
        await sleep(reason === "server_restart" ? 1_000 : backoffMs(attempt));
        attempt += 1;
      }
    }

    // Back on screen / back online: retry now instead of waiting for the backoff.
    const retryNow = () => {
      if (document.visibilityState === "visible") wake?.();
    };
    document.addEventListener("visibilitychange", retryNow);
    window.addEventListener("online", retryNow);
    setStatus("connecting");
    void run();

    return () => {
      stopped = true;
      controller?.abort();
      wake?.();
      if (flushTimer) clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", retryNow);
      window.removeEventListener("online", retryNow);
      setStatus("connecting");
    };
  }, [queryClient]);

  return children;
}
