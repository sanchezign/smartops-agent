import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Reglas" };

export default function Page() {
  return (
    <ComingSoon
      title="Reglas"
      description="Acá vas a ajustar las reglas del sistema sin tocar código."
    />
  );
}
