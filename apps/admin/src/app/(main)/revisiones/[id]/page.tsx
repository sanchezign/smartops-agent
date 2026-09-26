import type { Metadata } from "next";
import { ReviewDetail } from "@/features/reviews/components/review-detail";

export const metadata: Metadata = { title: "Revisión" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewDetail id={id} />;
}
