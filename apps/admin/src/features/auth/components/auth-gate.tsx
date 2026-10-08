"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { api } from "../api";
import { useAuthStore } from "../store";

/**
 * Protects the (main) routes: on first load the access token is not in memory yet, so a
 * silent refresh (HttpOnly cookie) recovers the session; without one → /login?next=….
 * The API enforces every permission anyway — this only avoids showing an empty panel.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unknown") void api.refresh();
    if (status === "anonymous") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== "authenticated") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8 text-sm text-muted-foreground">
        {t("loading")}
      </main>
    );
  }
  return <>{children}</>;
}
