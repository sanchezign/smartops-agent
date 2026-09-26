import type { Metadata } from "next";
import { Inbox } from "@/features/conversations/components/inbox";

export const metadata: Metadata = { title: "Conversaciones" };

export default function Page() {
  return <Inbox />;
}
