import type { ReviewItem, ReviewScope } from "./types";

/**
 * What kind of message a review (or a whole list) came from (phase 15): a code of the
 * "todo.source" messages, shown next to its icon (source-icon.tsx) — never the icon alone (ADR-029).
 */
export type SourceKind = "audio" | "image" | "spreadsheet" | "document" | "text";

export function sourceKind(message: Pick<ReviewItem["message"], "type" | "media">): SourceKind {
  const mime = message.media?.mimeType ?? "";
  if (message.type === "audio") return "audio";
  if (message.type === "image") return "image";
  if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv"))
    return "spreadsheet";
  if (message.type === "document") return "document";
  return "text";
}

const SCOPE_ORDER: Record<ReviewScope, number> = { run: 0, line: 1, catalog: 2 };

/**
 * The order of the items INSIDE one list, the same as GET /admin/todo: the run gate first, then
 * the order the items were created in (the list's own order), then id.
 */
export function listOrder<T extends Pick<ReviewItem, "scope" | "createdAt" | "id">>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
