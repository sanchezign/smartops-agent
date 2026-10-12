import { pageMetadata } from "@/i18n/metadata";
import { SystemView } from "@/features/catalog/components/system-view";

export const generateMetadata = pageMetadata("system");

/** Technical errors (ADR-032): admins; read-only for the public demo's operator. M4 completes it. */
export default function Page() {
  return <SystemView />;
}
