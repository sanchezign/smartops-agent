import { pageMetadata } from "@/i18n/metadata";
import { RulesView } from "@/features/rules/components/rules-view";

export const generateMetadata = pageMetadata("rules");

export default function Page() {
  return <RulesView />;
}
