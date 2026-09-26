"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/features/auth/api";
import { useApiQuery } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import type { ApproveInput, ReviewItem, ReviewScope, ReviewStatus, ReviewSummary } from "./types";

export interface ReviewFilter {
  status: ReviewStatus;
  scope: ReviewScope | "all";
}

export function reviewsPath(filter: ReviewFilter): string {
  const params = new URLSearchParams({ status: filter.status });
  if (filter.scope !== "all") params.set("scope", filter.scope);
  return `/admin/reviews?${params.toString()}`;
}

export const useReviews = (filter: ReviewFilter) =>
  useApiQuery<{ items: ReviewItem[] }>(["reviews", "list", filter], reviewsPath(filter));

export const useReviewSummary = () =>
  useApiQuery<ReviewSummary>(["reviews", "summary"], "/admin/reviews/summary");

export const useReview = (id: string) =>
  useApiQuery<{ item: ReviewItem }>(["reviews", "item", id], `/admin/reviews/${id}`);

export const useSuppliers = (enabled = true) =>
  useApiQuery<{ suppliers: { id: string; name: string }[] }>(["suppliers"], "/admin/suppliers", {
    staleTime: 60_000,
    enabled,
  });

/** What the person reads when a resolution fails (API codes → plain language). */
export function resolveErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "No se pudo guardar. Probá de nuevo.";
  switch (error.code) {
    case "STALE_REVIEW":
      return "El catálogo cambió desde que se armó esta propuesta, así que ya no aplica. Actualizamos la lista.";
    case "CONFLICT":
      return `No se pudo aplicar: ${error.message}`;
    case "FORBIDDEN":
      return "Solo un administrador puede resolver esta revisión.";
    case "BAD_REQUEST":
    case "VALIDATION_ERROR":
      return `Revisá los datos: ${error.message}`;
    default:
      return `No se pudo guardar${error.requestId ? ` (código ${error.requestId})` : ""}.`;
  }
}

export type ResolveInput =
  { action: "approve"; body: ApproveInput } | { action: "reject"; note?: string };

export function useResolveReview(id: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ResolveInput) =>
      api.request<{ result: { status: string }; retriggered: boolean }>(
        `/admin/reviews/${id}/${input.action}`,
        {
          method: "POST",
          body: JSON.stringify(
            input.action === "approve" ? input.body : input.note ? { note: input.note } : {},
          ),
        },
      ),
    onSuccess: (data, input) => {
      toast.success(
        input.action === "reject"
          ? "Revisión rechazada: no se cambió nada."
          : data.retriggered
            ? "Aprobada. La lista se vuelve a procesar con lo que elegiste."
            : "Aprobada y aplicada.",
      );
      onDone?.();
    },
    onError: (error) => toast.error(resolveErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
