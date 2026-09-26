import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Catálogo" };

export default function Page() {
  return (
    <ComingSoon
      title="Catálogo"
      description="Acá vas a ver los productos de cada proveedor y su historial de precios."
    />
  );
}
