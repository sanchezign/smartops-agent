import type { MessageStatus } from "../../generated/prisma/enums.js";

/**
 * Outbound message status rules (pure). Meta delivers statuses at-least-once and
 * possibly out of order, so a Message only moves FORWARD:
 *   pending < sent < delivered < read      (played counts as read)
 * `failed` overrides pending/sent/delivered, but never a `read` message.
 * Once failed, later sent/delivered/read do not revive it. Inbound messages
 * (status `received`) are never touched.
 */

const RANK: Partial<Record<MessageStatus, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** Maps a raw Meta status to our enum; null for values we only log (unknown/new ones). */
export function toMessageStatus(waStatus: string): MessageStatus | null {
  switch (waStatus) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return waStatus;
    case "played":
      return "read";
    default:
      return null;
  }
}

/** Statuses a Message may currently have for `next` to be applied. */
export function allowedPreviousStatuses(next: MessageStatus): MessageStatus[] {
  if (next === "failed") return ["pending", "sent", "delivered"];
  const nextRank = RANK[next];
  if (nextRank === undefined) return [];
  return (Object.keys(RANK) as MessageStatus[]).filter((s) => (RANK[s] ?? Infinity) < nextRank);
}

export function canTransition(current: MessageStatus, next: MessageStatus): boolean {
  return allowedPreviousStatuses(next).includes(current);
}
