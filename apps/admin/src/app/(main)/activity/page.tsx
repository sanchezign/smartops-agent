import { pageMetadata } from "@/i18n/metadata";
import { ActivityView } from "@/features/catalog/components/activity-view";

export const generateMetadata = pageMetadata("activity");

/** News (phase 15, ADR-032): what the system already did, grouped by day. */
export default function Page() {
  return <ActivityView />;
}
