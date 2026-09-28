"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clientEnv } from "@/env";
import { api } from "@/features/auth/api";
import { ApiError } from "@/lib/api-client";
import { isRecentlyResetDetails, recentlyResetMessage } from "./reset-message";
import type { DemoSampleKind, DemoTrace } from "./trace";

export interface DemoInfo {
  demoMode: true;
  operator: { email: string; password: string };
  nextResetAt: string | null;
}

/**
 * Is this the public demo? GET /api/v1/demo/info is public and only exists in DEMO_MODE
 * (404 otherwise → null: no banner, no demo page, no credentials on the login screen).
 */
export function useDemoInfo() {
  return useQuery({
    queryKey: ["demo", "info"],
    queryFn: async ({ signal }): Promise<DemoInfo | null> => {
      const res = await fetch(`${clientEnv.NEXT_PUBLIC_API_BASE}/demo/info`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`demo info ${res.status}`);
      return (await res.json()) as DemoInfo;
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useInject(onInjected: (kind: DemoSampleKind, wamid: string) => void) {
  return useMutation({
    mutationFn: (kind: DemoSampleKind) =>
      api.request<{ wamid: string }>("/demo/inject", {
        method: "POST",
        body: JSON.stringify({ kind }),
      }),
    onSuccess: (data, kind) => onInjected(kind, data.wamid),
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 429
          ? "Muchas pruebas seguidas: esperá unos minutos."
          : "No se pudo enviar el mensaje de prueba.",
      ),
  });
}

export function useTrace(wamid: string, finished: boolean) {
  return useQuery({
    queryKey: ["demo", "trace", wamid],
    queryFn: ({ signal }) =>
      api.request<DemoTrace>(`/demo/trace/${encodeURIComponent(wamid)}`, { signal }),
    refetchInterval: finished ? false : 1_500,
  });
}

export function useResetDemo(onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request<{ nextResetAt: string | null }>("/demo/reset", { method: "POST" }),
    onSuccess: () => {
      toast.success("Demo reiniciada: datos de ejemplo como al principio.");
      onDone();
      void queryClient.invalidateQueries();
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError &&
          error.code === "DEMO_RECENTLY_RESET" &&
          isRecentlyResetDetails(error.details)
          ? recentlyResetMessage(error.details)
          : error instanceof ApiError && error.status === 429
            ? "Se reinició hace poco: probá en unos minutos."
            : "No se pudo reiniciar la demo.",
      ),
  });
}
