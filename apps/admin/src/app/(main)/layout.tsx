import type { ReactNode } from "react";
import { AuthGate } from "@/features/auth/components/auth-gate";

export default function MainLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
