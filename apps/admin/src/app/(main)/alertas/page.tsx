import { pageMetadata } from "@/i18n/metadata";
import { AlertsView } from "@/features/catalog/components/alerts-view";

export const generateMetadata = pageMetadata("alerts");

export default function Page() {
  return <AlertsView />;
}
