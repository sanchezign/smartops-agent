import type { PrismaClient } from "../../common/db.js";
import type { ItemData } from "../notifications/digest-rules.js";

/**
 * Panel deep link of a WhatsApp digest (phase 9 M7): /d/<token> → the digest's items, each
 * with the panel screen that resolves it. The token is 256 random bits (not the digest id); the
 * route requires login; the URL carries no content.
 */

export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface DigestLinkItem {
  category: ItemData["category"];
  /** Technical / business-language fallback; the panel composes its own text from `data`. */
  title: string;
  /** The structured item (phase 13): the panel writes it in the panel language. */
  data: ItemData;
  createdAt: Date;
  /** Panel path that resolves it (null = nothing specific to open). */
  path: string | null;
}

export function createDigestLinkRepository(prisma: PrismaClient) {
  return {
    async byToken(token: string) {
      if (!LINK_TOKEN_PATTERN.test(token)) return null;
      const digest = await prisma.notificationDigest.findUnique({
        where: { linkToken: token },
        select: {
          createdAt: true,
          sentAt: true,
          critical: true,
          items: {
            orderBy: { createdAt: "asc" },
            select: { category: true, title: true, data: true, createdAt: true },
          },
        },
      });
      if (!digest) return null;

      // Customer messages → their conversation (one query for all of them).
      const messageIds = digest.items
        .map((i) => i.data as unknown as ItemData)
        .flatMap((d) =>
          d.category === "order" || d.category === "customer_query" ? [d.messageId] : [],
        );
      const messages = messageIds.length
        ? await prisma.message.findMany({
            where: { id: { in: messageIds } },
            select: { id: true, conversationId: true },
          })
        : [];
      const conversationOf = new Map(messages.map((m) => [m.id, m.conversationId]));

      const items: DigestLinkItem[] = digest.items.map((item) => {
        const data = item.data as unknown as ItemData;
        let path: string | null = null;
        switch (data.category) {
          case "order":
          case "customer_query": {
            const conversationId = conversationOf.get(data.messageId);
            path = conversationId ? `/conversaciones/${conversationId}` : null;
            break;
          }
          case "run_summary":
            path = data.pendingReviews > 0 ? "/revisiones" : "/catalogo";
            break;
          case "manual_attention":
          case "integration_error":
            path = "/alertas";
            break;
        }
        return {
          category: data.category,
          title: item.title,
          data,
          createdAt: item.createdAt,
          path,
        };
      });
      return {
        createdAt: digest.createdAt,
        sentAt: digest.sentAt,
        critical: digest.critical,
        items,
      };
    },
  };
}
export type DigestLinkRepository = ReturnType<typeof createDigestLinkRepository>;
