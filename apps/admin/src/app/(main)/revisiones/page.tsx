import type { Metadata } from "next";
import { ReviewList } from "@/features/reviews/components/review-list";

export const metadata: Metadata = { title: "Revisiones" };

export default function Page() {
  return <ReviewList />;
}
