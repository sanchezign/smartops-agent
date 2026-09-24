import { z } from "zod";

/**
 * Outbound message content (validated before anything is stored). Shared by the CLI now,
 * and by the internal API (phases 5/6) and the admin panel (phase 9) later.
 */

const templateParameterSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(1024),
});

export const templateComponentSchema = z.object({
  type: z.enum(["header", "body", "button"]),
  sub_type: z.enum(["quick_reply", "url"]).optional(),
  index: z.string().regex(/^\d$/).optional(),
  parameters: z.array(templateParameterSchema).max(20),
});

export const sendContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    // WhatsApp text body limit: 4096 characters.
    body: z.string().trim().min(1).max(4096),
    previewUrl: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("template"),
    name: z
      .string()
      .regex(/^[a-z0-9_]{1,512}$/, "template names are lowercase letters, digits and underscores"),
    languageCode: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'e.g. "es", "es_AR", "en_US"'),
    components: z.array(templateComponentSchema).max(10).optional(),
  }),
]);

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "use letters, digits and . _ : -");

export type SendContentInput = z.input<typeof sendContentSchema>;
