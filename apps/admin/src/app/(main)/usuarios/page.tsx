import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Usuarios" };

export default function Page() {
  return <ComingSoon title="Usuarios" description="Acá vas a administrar quién entra al panel." />;
}
