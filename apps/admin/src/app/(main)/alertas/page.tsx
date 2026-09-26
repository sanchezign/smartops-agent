import type { Metadata } from "next";
import { AlertsView } from "@/features/catalog/components/alerts-view";

export const metadata: Metadata = { title: "Alertas" };

export default function Page() {
  return <AlertsView />;
}
