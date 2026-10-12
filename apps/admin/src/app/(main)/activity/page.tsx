import { pageMetadata } from "@/i18n/metadata";
import { AlertsView } from "@/features/catalog/components/alerts-view";

export const generateMetadata = pageMetadata("activity");

/** News (ADR-032): alerts about something already done. Reworked in phase 15 M4. */
export default function Page() {
  return <AlertsView category="info" />;
}
