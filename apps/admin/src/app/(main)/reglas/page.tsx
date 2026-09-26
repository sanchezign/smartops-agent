import type { Metadata } from "next";
import { RulesView } from "@/features/rules/components/rules-view";

export const metadata: Metadata = { title: "Reglas" };

export default function Page() {
  return <RulesView />;
}
