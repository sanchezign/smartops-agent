import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Conversaciones" };

export default function Page() {
  return (
    <ComingSoon
      title="Conversaciones"
      description="Acá vas a ver los chats, quién responde y contestar como persona."
    />
  );
}
