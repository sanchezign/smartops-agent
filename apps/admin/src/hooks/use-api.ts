"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/features/auth/api";

/** GET through the authenticated client (Bearer + one refresh on 401). */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  options: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: ({ signal }) => api.request<T>(path, { signal }),
    ...options,
  });
}
