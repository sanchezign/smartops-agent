import { pageMetadata } from "@/i18n/metadata";
import { ProductDetail } from "@/features/catalog/components/product-detail";

export const generateMetadata = pageMetadata("product");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetail id={id} />;
}
