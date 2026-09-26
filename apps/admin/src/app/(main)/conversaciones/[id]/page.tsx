import type { Metadata } from "next";
import { ChatView } from "@/features/conversations/components/chat-view";

export const metadata: Metadata = { title: "Conversación" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView id={id} />;
}
