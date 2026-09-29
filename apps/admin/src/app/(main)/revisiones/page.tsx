import { pageMetadata } from "@/i18n/metadata";
import { ReviewList } from "@/features/reviews/components/review-list";

export const generateMetadata = pageMetadata("reviews");

export default function Page() {
  return <ReviewList />;
}
