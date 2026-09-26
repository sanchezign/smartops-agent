import type { Metadata } from "next";
import { CatalogView } from "@/features/catalog/components/catalog-view";

export const metadata: Metadata = { title: "Catálogo" };

export default function Page() {
  return <CatalogView />;
}
