import type { Metadata } from "next";
import { OptedOutList } from "@/features/conversations/components/opted-out-list";

export const metadata: Metadata = { title: "Dados de baja" };

export default function Page() {
  return <OptedOutList />;
}
