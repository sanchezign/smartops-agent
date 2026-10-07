"use client";

import { useApiQuery } from "@/hooks/use-api";
import type { DashboardData } from "./types";

/**
 * What waits for a person, for the navigation counters (phase 14, ADR-029). Same query key as the
 * Home with 7 days, so both share one request; every review / alert / message event already
 * refreshes the ["dashboard"] queries (ADR-020).
 */
export function usePendingCounts(): { reviews: number; alerts: number } | null {
  const query = useApiQuery<DashboardData>(["dashboard", 7], "/admin/dashboard?days=7", {
    staleTime: 30_000,
  });
  if (!query.data) return null;
  return { reviews: query.data.pending.reviews, alerts: query.data.pending.openAlerts };
}
