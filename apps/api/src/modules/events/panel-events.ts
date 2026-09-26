import { z } from "zod";

/**
 * Real-time events for the panel (phase 9 M4, ADR-020). What the database triggers publish on
 * `smartops_events` (migration `realtime_events`), re-validated here: only the known types and
 * fields go out to browsers — ids and statuses, never message content. Anything unexpected is
 * dropped (logged by the listener).
 */

export const PANEL_EVENTS_CHANNEL = "smartops_events";

const id = z.uuid();
const short = z.string().max(40);

export const panelEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message.created"),
      conversationId: id,
      messageId: id,
      direction: short,
    })
    .strip(),
  z
    .object({
      type: z.literal("message.updated"),
      conversationId: id,
      messageId: id,
      status: short.optional(),
      mediaStatus: short.optional(),
    })
    .strip(),
  z.object({ type: z.literal("conversation.updated"), conversationId: id, mode: short }).strip(),
  z.object({ type: z.literal("contact.updated"), contactId: id }).strip(),
  z.object({ type: z.literal("review.changed"), reviewId: id, status: short }).strip(),
  z.object({ type: z.literal("run.changed"), runId: id, status: short }).strip(),
  z.object({ type: z.literal("alert.changed"), alertId: id, severity: short }).strip(),
  z.object({ type: z.literal("catalog.changed"), supplierIds: z.array(id).max(50) }).strip(),
]);
export type PanelEvent = z.infer<typeof panelEventSchema>;

/** NOTIFY payload → a panel event, or null when it is not valid JSON / not a known event. */
export function parsePanelEvent(payload: string | undefined): PanelEvent | null {
  if (!payload) return null;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = panelEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Identity of an event for coalescing: the same change announced twice is sent once. */
export function eventKey(event: PanelEvent): string {
  return JSON.stringify(event);
}
