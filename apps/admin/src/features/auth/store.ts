"use client";

import { create } from "zustand";
import type { Session, SessionUser } from "@/lib/api-client";

/**
 * Session state (phase 8). IN MEMORY ONLY — never persisted (no localStorage): a reload
 * recovers the session through the HttpOnly refresh cookie.
 */
export type AuthStatus = "unknown" | "authenticated" | "anonymous";

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: SessionUser | null;
  setSession(session: Session): void;
  signOut(): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "unknown",
  accessToken: null,
  user: null,
  setSession: (session) =>
    set({ status: "authenticated", accessToken: session.accessToken, user: session.user }),
  signOut: () => set({ status: "anonymous", accessToken: null, user: null }),
}));
