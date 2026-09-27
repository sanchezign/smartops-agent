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
import { DEGRADED_POLL_MS, READY_TIMEOUT_MS, statusAfterFailure, useRealtimeStore } from "./store";

const FLUSH_MS = 200;

/**
 * Keeps ONE event stream per tab (POST /api/v1/events, ADR-020 — POST because Cloudflare's
 * edge holds GET streams) and turns events into query
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
      const attemptController = new AbortController();
      controller = attemptController;
      let sessionEnd: string | null = null;
      let ready = false;
      // No "ready" in time (a proxy holding the stream): degraded mode + retry later.
      const readyTimer = setTimeout(() => {
        if (ready) return;
        setStatus("degraded");
        attemptController.abort();
      }, READY_TIMEOUT_MS);
      try {
        return await readStream();
      } finally {
        clearTimeout(readyTimer);
      }

      async function readStream(): Promise<string | null> {
        const res = await api.stream("/events", {
          method: "POST",
          signal: attemptController.signal,
          headers: { accept: "text/event-stream" },
        });
        const parser = createSseParser({
          onFrame(frame) {
            if (frame.event === "ready") {
              ready = true;
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
        setStatus(statusAfterFailure(useRealtimeStore.getState().status));
        if (reason === "ended" || reason === "role_changed") {
          if (!(await api.refresh())) return;
          attempt = 0;
          continue;
        }
        await sleep(reason === "server_restart" ? 1_000 : backoffMs(attempt));
        attempt += 1;
      }
    }

    // Back on screen / back online: refresh what is on screen and retry the stream now.
    const retryNow = () => {
      if (document.visibilityState !== "visible") return;
      void queryClient.invalidateQueries({ type: "active" });
      wake?.();
    };
    // Not live (degraded / reconnecting): refresh the screen periodically, so nothing ever
    // needs a browser restart.
    const poll = setInterval(() => {
      if (useRealtimeStore.getState().status === "live") return;
      if (document.visibilityState === "visible")
        void queryClient.invalidateQueries({ type: "active" });
    }, DEGRADED_POLL_MS);
    document.addEventListener("visibilitychange", retryNow);
    window.addEventListener("online", retryNow);
    setStatus("connecting");
    void run();

    return () => {
      stopped = true;
      clearInterval(poll);
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
