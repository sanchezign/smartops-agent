import { pageMetadata } from "@/i18n/metadata";
import { ChatView } from "@/features/conversations/components/chat-view";

export const generateMetadata = pageMetadata("conversation");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView id={id} />;
}
