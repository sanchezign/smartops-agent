"use client";

import { create } from "zustand";

/** State of the real-time connection (phase 9 M4). "live" turns polling off. */
export type RealtimeStatus = "connecting" | "live" | "offline";

export const useRealtimeStore = create<{
  status: RealtimeStatus;
  setStatus(status: RealtimeStatus): void;
}>((set) => ({
  status: "connecting",
  setStatus: (status) => set({ status }),
}));

/** Fallback polling interval for a query: none while live, `ms` otherwise. */
export function useFallbackInterval(ms: number): number | false {
  const status = useRealtimeStore((s) => s.status);
  return status === "live" ? false : ms;
}
