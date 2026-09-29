import { pageMetadata } from "@/i18n/metadata";
import { Inbox } from "@/features/conversations/components/inbox";

export const generateMetadata = pageMetadata("conversations");

export default function Page() {
  return <Inbox />;
}
