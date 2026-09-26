import type { Metadata } from "next";
import { ProductDetail } from "@/features/catalog/components/product-detail";

export const metadata: Metadata = { title: "Producto" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetail id={id} />;
}
