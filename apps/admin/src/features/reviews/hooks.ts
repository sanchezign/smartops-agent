"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
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

export type ResolveErrorKey =
  "generic" | "stale" | "conflict" | "forbidden" | "invalid" | "withCode" | "noCode";

/**
 * What the person reads when a resolution fails: API codes → a "reviews.errors" key + params.
 * "detail" is the API message (English, technical) shown after the translated sentence.
 */
export function resolveErrorKey(error: unknown): {
  key: ResolveErrorKey;
  params?: Record<string, string>;
} {
  if (!(error instanceof ApiError)) return { key: "generic" };
  switch (error.code) {
    case "STALE_REVIEW":
      return { key: "stale" };
    case "CONFLICT":
      return { key: "conflict", params: { detail: error.message } };
    case "FORBIDDEN":
      return { key: "forbidden" };
    case "BAD_REQUEST":
    case "VALIDATION_ERROR":
      return { key: "invalid", params: { detail: error.message } };
    default:
      return error.requestId
        ? { key: "withCode", params: { requestId: error.requestId } }
        : { key: "noCode" };
  }
}

export type ResolveInput =
  { action: "approve"; body: ApproveInput } | { action: "reject"; note?: string };

export function useResolveReview(id: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  const t = useTranslations("reviews");
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
          ? t("toast.rejected")
          : data.retriggered
            ? t("toast.approvedRetriggered")
            : t("toast.approved"),
      );
      onDone?.();
    },
    onError: (error) => {
      const { key, params } = resolveErrorKey(error);
      toast.error(t(`errors.${key}`, params));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
