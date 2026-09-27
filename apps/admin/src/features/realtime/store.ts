"use client";

import { create } from "zustand";

/**
 * State of the real-time connection (phase 9 M4; degraded mode after the phone tests):
 * - connecting: first attempt, waiting for "ready" (up to READY_TIMEOUT_MS);
 * - live: events arrive, no polling;
 * - offline: a live stream dropped, reconnecting;
 * - degraded: no "ready" in time (e.g. a proxy that holds the stream) → every screen is
 *   refreshed every DEGRADED_POLL_MS while it keeps retrying in the background.
 */
export type RealtimeStatus = "connecting" | "live" | "offline" | "degraded";

export const READY_TIMEOUT_MS = 10_000;
export const DEGRADED_POLL_MS = 30_000;

export const useRealtimeStore = create<{
  status: RealtimeStatus;
  setStatus(status: RealtimeStatus): void;
}>((set) => ({
  status: "connecting",
  setStatus: (status) => set({ status }),
}));

/** After an attempt fails: a live stream is "reconnecting"; otherwise it stays as it was. */
export function statusAfterFailure(current: RealtimeStatus): RealtimeStatus {
  return current === "live" ? "offline" : current;
}
