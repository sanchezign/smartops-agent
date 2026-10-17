import { Suspense } from "react";
import { pageMetadata } from "@/i18n/metadata";
import { Inbox } from "@/features/conversations/components/inbox";

export const generateMetadata = pageMetadata("conversations");

export default function Page() {
  // Suspense: the filters are read from the URL (useSearchParams).
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
