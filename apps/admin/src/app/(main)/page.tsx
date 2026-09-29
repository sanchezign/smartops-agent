import { pageMetadata } from "@/i18n/metadata";
import { DashboardView } from "@/features/dashboard/components/dashboard-view";

export const generateMetadata = pageMetadata("home");

export default function HomePage() {
  return <DashboardView />;
}
