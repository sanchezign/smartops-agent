import type { Metadata } from "next";
import { TryView } from "@/features/demo/components/try-view";

export const metadata: Metadata = { title: "Probar el sistema" };

export default function Page() {
  return <TryView />;
}
