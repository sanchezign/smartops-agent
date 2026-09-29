import { pageMetadata } from "@/i18n/metadata";
import { TryView } from "@/features/demo/components/try-view";

export const generateMetadata = pageMetadata("try");

export default function Page() {
  return <TryView />;
}
