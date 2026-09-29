import { pageMetadata } from "@/i18n/metadata";
import { OptedOutList } from "@/features/conversations/components/opted-out-list";

export const generateMetadata = pageMetadata("optedOut");

export default function Page() {
  return <OptedOutList />;
}
