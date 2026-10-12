import { pageMetadata } from "@/i18n/metadata";
import { ResolvedList } from "@/features/reviews/components/resolved-list";

export const generateMetadata = pageMetadata("resolved");

export default function Page() {
  return <ResolvedList />;
}
