"use client";

import { ForbiddenState, LoadingState } from "@/components/states";
import { canSeeSystem } from "@/components/layout/nav-items";
import { useAuthStore } from "@/features/auth/store";
import { useDemoInfo } from "@/features/demo/hooks";
import { AlertsView } from "./alerts-view";

/**
 * System status (phase 15, ADR-032): technical alerts, for admins; in the public demo the
 * operator sees it read-only (D1). The API does not change: this only decides what the panel
 * offers (an operator can still acknowledge through the API, as before).
 */
export function SystemView() {
  const user = useAuthStore((s) => s.user);
  const demo = useDemoInfo();
  if (demo.isPending) return <LoadingState rows={3} />;
  const isDemo = demo.data != null;
  if (!canSeeSystem(user, isDemo)) return <ForbiddenState />;
  return <AlertsView category="technical" readOnly={user?.role !== "admin"} />;
}
