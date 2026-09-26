import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Revisiones" };

export default function Page() {
  return (
    <ComingSoon
      title="Revisiones"
      description="Acá vas a aprobar o rechazar lo que el sistema no decide solo."
    />
  );
}
