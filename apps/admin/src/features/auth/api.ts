"use client";

import { clientEnv } from "@/env";
import { createApiClient } from "@/lib/api-client";
import { useAuthStore } from "./store";

/** The panel's single API client, bound to the in-memory auth store. */
export const api = createApiClient({
  base: clientEnv.NEXT_PUBLIC_API_BASE,
  fetch: (...args) => fetch(...args),
  getAccessToken: () => useAuthStore.getState().accessToken,
  onSession: (session) => useAuthStore.getState().setSession(session),
  onSignedOut: () => useAuthStore.getState().signOut(),
  ...(typeof navigator !== "undefined" && navigator.locks
    ? {
        locks: {
          request: <T>(name: string, callback: () => Promise<T>) =>
            navigator.locks.request(name, callback) as Promise<T>,
        },
      }
    : {}),
});
