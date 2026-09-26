import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Alertas" };

export default function Page() {
  return (
    <ComingSoon
      title="Alertas"
      description="Acá vas a ver los aumentos grandes, el stock bajo y los errores."
    />
  );
}
