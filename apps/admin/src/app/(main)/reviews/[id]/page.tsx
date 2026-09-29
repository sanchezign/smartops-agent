import { pageMetadata } from "@/i18n/metadata";
import { ReviewDetail } from "@/features/reviews/components/review-detail";

export const generateMetadata = pageMetadata("review");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewDetail id={id} />;
}
