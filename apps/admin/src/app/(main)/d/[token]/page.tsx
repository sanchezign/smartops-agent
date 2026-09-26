import type { Metadata } from "next";
import { DigestView } from "@/features/digests/components/digest-view";

export const metadata: Metadata = { title: "Resumen", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <DigestView token={token} />;
}
