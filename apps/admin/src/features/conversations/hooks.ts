"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/features/auth/api";
import { useFallbackInterval } from "@/features/realtime/store";
import { useApiQuery } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import type {
  ChatMessage,
  ConversationHeader,
  InboxFilter,
  InboxItem,
  OptedOutContact,
} from "./types";

/** Only while the real-time stream is down (ADR-020): then the chat and the inbox poll. */
const FALLBACK_POLL_MS = 30_000;

export function useInbox(filter: InboxFilter, q: string) {
  const refetchInterval = useFallbackInterval(FALLBACK_POLL_MS);
  return useInfiniteQuery({
    queryKey: ["conversations", "inbox", filter, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ filter, limit: "30" });
      if (q) params.set("q", q);
      if (pageParam) params.set("cursor", pageParam);
      return api.request<{ items: InboxItem[]; nextCursor: string | null }>(
        `/admin/conversations?${params.toString()}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
  });
}

export function useConversation(id: string) {
  const refetchInterval = useFallbackInterval(FALLBACK_POLL_MS);
  return useApiQuery<{ conversation: ConversationHeader }>(
    ["conversations", "header", id],
    `/admin/conversations/${id}`,
    { refetchInterval },
  );
}

/** Chat history: pages go BACKWARDS (older) — `before` = oldest message already loaded. */
export function useMessages(id: string) {
  const refetchInterval = useFallbackInterval(FALLBACK_POLL_MS);
  return useInfiniteQuery({
    queryKey: ["conversations", "messages", id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "40" });
      if (pageParam) params.set("before", pageParam);
      return api.request<{ items: ChatMessage[]; hasMore: boolean }>(
        `/admin/conversations/${id}/messages?${params.toString()}`,
        { signal },
      );
    },
    getNextPageParam: (last) => (last.hasMore ? (last.items[0]?.id ?? null) : null),
    refetchInterval,
  });
}

export const useOptedOut = () =>
  useApiQuery<{ contacts: OptedOutContact[] }>(
    ["contacts", "opted-out"],
    "/admin/contacts/opted-out",
  );

const MUTATION_ERRORS: Record<string, string> = {
  WINDOW_CLOSED:
    "Pasaron más de 24 h desde su último mensaje: WhatsApp solo permite plantillas aprobadas.",
  OPTED_OUT: "Este contacto pidió no recibir mensajes.",
  FORBIDDEN: "Esta acción es solo para administradores.",
  VALIDATION_ERROR: "Revisá los datos.",
};

export function conversationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return (
      MUTATION_ERRORS[error.code] ??
      `No se pudo completar${error.requestId ? ` (código ${error.requestId})` : ""}.`
    );
  }
  return "No se pudo completar. Probá de nuevo.";
}

/** Pause / resume / reply / opt-out / opt-in, each refreshing the chat and the inbox. */
export function useConversationAction<TInput>(
  build: (input: TInput) => { path: string; body?: unknown },
  success: string | ((data: unknown) => string),
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const { path, body } = build(input);
      return api.request<unknown>(path, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      });
    },
    onSuccess: (data) => toast.success(typeof success === "string" ? success : success(data)),
    onError: (error) => toast.error(conversationErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

/**
 * Chat media through the authenticated client (ADR-019): the Blob is cached by TanStack Query,
 * the blob: URL is created for this component and revoked when it unmounts or changes.
 */
export function useMediaBlob(mediaId: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["media", mediaId],
    queryFn: ({ signal }) => api.requestBlob(`/admin/media/${mediaId}`, { signal }),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!query.data) return;
    const objectUrl = URL.createObjectURL(query.data);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [query.data]);
  return { ...query, url };
}
