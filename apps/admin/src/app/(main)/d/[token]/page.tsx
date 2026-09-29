import { pageMetadata } from "@/i18n/metadata";
import { DigestView } from "@/features/digests/components/digest-view";

export const generateMetadata = pageMetadata("digest", { referrer: "no-referrer" });

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <DigestView token={token} />;
}
