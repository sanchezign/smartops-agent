import type { AlertItem } from "@/features/catalog/types";
import type { ReviewItem } from "@/features/reviews/types";

/** To do as the panel API returns it (GET /admin/todo, phase 15, ADR-032). */

export interface ReviewSplit {
  /** Pending items THIS user may resolve (the API splits them with canResolveReview). */
  canResolve: number;
  /** Pending items only an admin may resolve. */
  waitingForAdmin: number;
}

export interface TodoCounts {
  /** The ONE yellow counter of the navigation: canResolve + action alerts. */
  total: number;
  reviews: ReviewSplit;
  alerts: number;
}

export interface TodoGroup {
  run: { id: string; status: string };
  supplier: { id: string; name: string } | null;
  message: ReviewItem["message"];
  /** All pending items of this list (`items` holds the first 5). */
  pending: number;
  reviews: ReviewSplit;
  items: ReviewItem[];
}

export interface TodoAlert extends Pick<
  AlertItem,
  "id" | "type" | "severity" | "status" | "title" | "details" | "createdAt"
> {
  conversationId: string | null;
  contactId: string | null;
}

export interface TodoView {
  counts: TodoCounts;
  groups: TodoGroup[];
  groupsTruncated: boolean;
  alerts: TodoAlert[];
}
