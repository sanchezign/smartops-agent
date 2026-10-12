"use client";

import { useApiQuery } from "@/hooks/use-api";
import type { ReviewItem } from "@/features/reviews/types";
import type { TodoCounts, TodoView } from "./types";

/**
 * To do (phase 15, ADR-032). Every review / alert event refreshes the ["todo"] queries
 * (features/realtime/invalidation.ts), so the counter follows what other people resolve.
 */

export const useTodo = () => useApiQuery<TodoView>(["todo", "list"], "/admin/todo");

/** Counters only (the navigation badge): never the lists. */
export const useTodoCounts = () =>
  useApiQuery<TodoCounts>(["todo", "summary"], "/admin/todo/summary", { staleTime: 30_000 });

/** Every pending item of one list ("View all"), in the list's order. */
export const useListReviews = (runId: string, enabled: boolean) =>
  useApiQuery<{ items: ReviewItem[] }>(
    ["todo", "run", runId],
    `/admin/reviews?status=pending&runId=${encodeURIComponent(runId)}&limit=200`,
    { enabled },
  );
