"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/features/auth/api";
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

/**
 * A one-click decision from the list (phase 15 M3): approve with an EMPTY body or reject without
 * a note — exactly what the row shows (quick-decision.ts decides when that is the case). The
 * row shows the outcome and the errors itself.
 */
export function useQuickDecision(reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "approve" | "reject") =>
      api.request<{ result: { status: string } }>(`/admin/reviews/${reviewId}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSettled: () => {
      for (const key of ["reviews", "todo", "dashboard", "catalog"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/**
 * "Opt out" on a possible opt-out (phase 15 M3): records the opt-out by hand (the same route as
 * the chat's menu, ADR-017; every role) and then marks the alert as done. Asked for confirmation
 * first by the caller: only an admin can opt the contact back in.
 */
export function useOptOutFromTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contactId: string; alertId: string; reason: string }) => {
      await api.request(`/admin/contacts/${input.contactId}/opt-out`, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason, source: "manual" }),
      });
      await api.request(`/admin/alerts/${input.alertId}/acknowledge`, { method: "POST" });
    },
    onSettled: () => {
      for (const key of ["todo", "alerts", "conversations", "contacts", "dashboard"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
