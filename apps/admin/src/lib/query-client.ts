import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * TanStack Query defaults (phase 9). Client errors are final (a 403 or a 404 does not get
 * better by retrying); network or server errors retry twice. Data stays fresh for 30 s and
 * real-time events (SSE, M4) invalidate what changed.
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
          failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}
