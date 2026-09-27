import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { customerServiceWindow } from "../whatsapp/customer-service-window.js";

/**
 * Read model of conversations for the panel (phase 9 M3): inbox, chat history and the list of
 * opted-out contacts. Read-only — mode changes, replies and consent go through their services
 * (ADR-016 / ADR-017). Message bodies are returned to the authenticated panel only; they are
 * never logged.
 */

export type InboxFilter = "all" | "human" | "opted_out" | "suppliers" | "customers";

export interface InboxItem {
  id: string;
  contact: ContactSummary;
  mode: "bot" | "human";
  humanUntil: Date | null;
  lastMessageAt: Date | null;
  window: { open: boolean; closesAt: Date | null };
  lastMessage: {
    direction: "inbound" | "outbound";
    type: string;
    author: string;
    snippet: string | null;
    status: string;
    at: Date;
  } | null;
}

export interface ContactSummary {
  id: string;
  name: string | null;
  waId: string | null;
  username: string | null;
  kind: string;
  supplier: { id: string; name: string } | null;
  optOutAt: Date | null;
}

export interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  author: string;
  authorName: string | null;
  purpose: string | null;
  text: string | null;
  transcript: string | null;
  status: string;
  errorCode: string | null;
  revokedAt: Date | null;
  editedAt: Date | null;
  at: Date;
  media: {
    id: string;
    mimeType: string;
    filename: string | null;
    sizeBytes: number | null;
    status: string;
    rejectReason: string | null;
  } | null;
}

export const SNIPPET_CHARS = 120;

/** One line for the inbox: first 120 chars, whitespace collapsed. */
export function snippet(text: string | null): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line;
}

const contactSelect = {
  id: true,
  name: true,
  waId: true,
  username: true,
  kind: true,
  optOutAt: true,
  supplier: { select: { id: true, name: true } },
} as const;

function inboxWhere(filter: InboxFilter, q: string | undefined): Prisma.ConversationWhereInput {
  const and: Prisma.ConversationWhereInput[] = [{ lastMessageAt: { not: null } }];
  if (filter === "human") and.push({ mode: "human" });
  if (filter === "opted_out") and.push({ contact: { optOutAt: { not: null } } });
  if (filter === "suppliers") and.push({ contact: { kind: "supplier" } });
  if (filter === "customers") and.push({ contact: { kind: { in: ["customer", "internal"] } } });
  if (q) {
    const digits = q.replace(/\D/g, "");
    and.push({
      OR: [
        { contact: { name: { contains: q, mode: "insensitive" } } },
        { contact: { supplier: { name: { contains: q, mode: "insensitive" } } } },
        ...(digits.length >= 3 ? [{ contact: { waId: { contains: digits } } }] : []),
      ],
    });
  }
  return { AND: and };
}

export function createConversationQueryRepository(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
) {
  return {
    /** Inbox, most recent first. Cursor = id of the last item of the previous page. */
    async list(input: {
      filter: InboxFilter;
      q?: string;
      cursor?: string;
      limit: number;
    }): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
      const rows = await prisma.conversation.findMany({
        where: inboxWhere(input.filter, input.q),
        orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          mode: true,
          humanUntil: true,
          lastMessageAt: true,
          lastInboundAt: true,
          contact: { select: contactSelect },
          messages: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              direction: true,
              type: true,
              author: true,
              text: true,
              transcript: true,
              status: true,
              waTimestamp: true,
              createdAt: true,
            },
          },
        },
      });
      const page = rows.slice(0, input.limit);
      const at = now();
      return {
        items: page.map((c) => {
          const m = c.messages[0];
          return {
            id: c.id,
            contact: c.contact,
            mode: c.mode,
            humanUntil: c.humanUntil,
            lastMessageAt: c.lastMessageAt,
            window: customerServiceWindow(c.lastInboundAt, at),
            lastMessage: m
              ? {
                  direction: m.direction,
                  type: m.type,
                  author: m.author,
                  snippet: snippet(m.transcript ?? m.text),
                  status: m.status,
                  at: m.waTimestamp ?? m.createdAt,
                }
              : null,
          };
        }),
        nextCursor: rows.length > input.limit ? page[page.length - 1]!.id : null,
      };
    },

    /** Header of the chat: contact, mode (+ last change), 24 h window. */
    async get(id: string) {
      const c = await prisma.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          mode: true,
          humanUntil: true,
          modeChangedAt: true,
          lastInboundAt: true,
          contact: {
            select: {
              ...contactSelect,
              optOutSource: true,
              optInAt: true,
              optInSource: true,
            },
          },
          modeChanges: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              reason: true,
              createdAt: true,
              actorLabel: true,
              actorUser: { select: { name: true } },
            },
          },
        },
      });
      if (!c) return null;
      const change = c.modeChanges[0];
      return {
        id: c.id,
        contact: c.contact,
        mode: c.mode,
        humanUntil: c.humanUntil,
        modeChangedAt: c.modeChangedAt,
        lastChange: change
          ? {
              reason: change.reason,
              at: change.createdAt,
              by: change.actorUser?.name ?? change.actorLabel,
            }
          : null,
        window: customerServiceWindow(c.lastInboundAt, now()),
      };
    },

    /**
     * Chat history, returned OLDEST first within the page. `before` = id of the oldest
     * message already shown (loads the previous page).
     */
    async messages(
      conversationId: string,
      input: { before?: string; limit: number },
    ): Promise<{ items: ChatMessage[]; hasMore: boolean } | null> {
      // An unknown conversation is a 404 (like the header), never an empty chat.
      if ((await prisma.conversation.count({ where: { id: conversationId } })) === 0) return null;
      const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.before ? { cursor: { id: input.before }, skip: 1 } : {}),
        select: {
          id: true,
          direction: true,
          type: true,
          author: true,
          purpose: true,
          text: true,
          transcript: true,
          status: true,
          errorCode: true,
          revokedAt: true,
          editedAt: true,
          waTimestamp: true,
          createdAt: true,
          authorUser: { select: { name: true } },
          mediaFile: {
            select: {
              id: true,
              mimeType: true,
              filename: true,
              sizeBytes: true,
              status: true,
              rejectReason: true,
            },
          },
        },
      });
      const page = rows.slice(0, input.limit).reverse();
      return {
        hasMore: rows.length > input.limit,
        items: page.map((m) => ({
          id: m.id,
          direction: m.direction,
          type: m.type,
          author: m.author,
          authorName: m.authorUser?.name ?? null,
          purpose: m.purpose,
          text: m.text,
          transcript: m.transcript,
          status: m.status,
          errorCode: m.errorCode,
          revokedAt: m.revokedAt,
          editedAt: m.editedAt,
          at: m.waTimestamp ?? m.createdAt,
          media: m.mediaFile,
        })),
      };
    },

    /** Contacts that asked not to receive messages (the list the panel must show, ADR-017). */
    async optedOut() {
      const contacts = await prisma.contact.findMany({
        where: { optOutAt: { not: null } },
        orderBy: { optOutAt: "desc" },
        take: 500,
        select: {
          ...contactSelect,
          optOutSource: true,
          conversation: { select: { id: true } },
          consentEvents: {
            where: { kind: "opt_out" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              method: true,
              keyword: true,
              note: true,
              actorUser: { select: { name: true } },
            },
          },
        },
      });
      return contacts.map(({ consentEvents, conversation, ...c }) => ({
        ...c,
        conversationId: conversation?.id ?? null,
        lastOptOut: consentEvents[0]
          ? {
              method: consentEvents[0].method,
              keyword: consentEvents[0].keyword,
              note: consentEvents[0].note,
              by: consentEvents[0].actorUser?.name ?? null,
            }
          : null,
      }));
    },

    /** Media metadata for the download route (only stored media has bytes). */
    async media(id: string) {
      return prisma.mediaFile.findUnique({
        where: { id },
        select: { id: true, mimeType: true, filename: true, status: true, sizeBytes: true },
      });
    },
  };
}
export type ConversationQueryRepository = ReturnType<typeof createConversationQueryRepository>;
