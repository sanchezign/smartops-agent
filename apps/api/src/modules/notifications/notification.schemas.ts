import { z } from "zod";

/** Bodies of the internal endpoints n8n calls (phase 6). */

export const notifySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("customer_query"), messageId: z.uuid() }).strict(),
  z.object({ kind: z.literal("order"), messageId: z.uuid() }).strict(),
  z.object({ kind: z.literal("manual_attention"), alertId: z.uuid() }).strict(),
]);
export type NotifyInput = z.infer<typeof notifySchema>;

/** n8n error workflow (Error Trigger) → backend. */
export const n8nErrorSchema = z
  .object({
    workflow: z.string().trim().min(1).max(200),
    node: z.string().trim().max(200).optional(),
    executionId: z.string().trim().max(100).optional(),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type N8nErrorInput = z.infer<typeof n8nErrorSchema>;

export const ackSchema = z.object({ runId: z.uuid() }).strict();
