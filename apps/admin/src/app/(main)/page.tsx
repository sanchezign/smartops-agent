import type { Metadata } from "next";
import { DashboardView } from "@/features/dashboard/components/dashboard-view";

export const metadata: Metadata = { title: "Inicio" };

export default function HomePage() {
  return <DashboardView />;
}
