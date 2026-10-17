import { Suspense } from "react";
import { pageMetadata } from "@/i18n/metadata";
import { CatalogView } from "@/features/catalog/components/catalog-view";

export const generateMetadata = pageMetadata("catalog");

export default function Page() {
  // Suspense: the filters are read from the URL (useSearchParams).
  return (
    <Suspense>
      <CatalogView />
    </Suspense>
  );
}
