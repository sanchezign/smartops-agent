/**
 * Which cached queries a panel event makes stale (phase 9 M4, ADR-020). Pure. Events carry
 * ids only: the panel refetches through the normal authenticated API, so role rules apply.
 */

export type PanelEvent =
  | { type: "message.created"; conversationId: string; messageId: string; direction: string }
  | {
      type: "message.updated";
      conversationId: string;
      messageId: string;
      status?: string;
      mediaStatus?: string;
    }
  | { type: "conversation.updated"; conversationId: string; mode: string }
  | { type: "contact.updated"; contactId: string }
  | { type: "review.changed"; reviewId: string; status: string }
  | { type: "run.changed"; runId: string; status: string }
  | { type: "alert.changed"; alertId: string; severity: string }
  | { type: "catalog.changed"; supplierIds: string[] };

export type QueryKeyPrefix = readonly string[];

export function keysFor(event: PanelEvent): QueryKeyPrefix[] {
  switch (event.type) {
    case "message.created":
      return [
        ["conversations", "messages", event.conversationId],
        ["conversations", "inbox"],
        // an inbound message reopens the 24 h window shown in the header
        ["conversations", "header", event.conversationId],
        ["dashboard"],
      ];
    case "message.updated":
      return [
        ["conversations", "messages", event.conversationId],
        ["conversations", "inbox"],
      ];
    case "conversation.updated":
      return [
        ["conversations", "header", event.conversationId],
        ["conversations", "inbox"],
      ];
    case "contact.updated":
      return [["conversations"], ["contacts"]];
    case "review.changed":
      return [["reviews"], ["dashboard"]];
    case "run.changed":
      return [["dashboard"]];
    case "alert.changed":
      return [["alerts"], ["dashboard"]];
    case "catalog.changed":
      return [["catalog"], ["suppliers"]];
    default:
      return [];
  }
}

/** Several events → the distinct prefixes to invalidate (a broader prefix covers narrower ones). */
export function mergeKeys(keys: QueryKeyPrefix[]): QueryKeyPrefix[] {
  const unique = [...new Map(keys.map((k) => [JSON.stringify(k), k])).values()];
  const covered = (k: QueryKeyPrefix, by: QueryKeyPrefix) =>
    by.length < k.length && by.every((part, i) => part === k[i]);
  return unique.filter((k) => !unique.some((other) => covered(k, other)));
}

/** Reconnection delay: 1 s doubling to 30 s, with ±20 % jitter so tabs do not reconnect together. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(base * (0.8 + random() * 0.4));
}
