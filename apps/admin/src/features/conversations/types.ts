/** Conversations as the panel API returns them (phase 9 M3). */

export type InboxFilter = "all" | "human" | "opted_out" | "suppliers" | "customers";

export interface ContactSummary {
  id: string;
  name: string | null;
  waId: string | null;
  username: string | null;
  kind: "supplier" | "customer" | "internal" | "unknown";
  supplier: { id: string; name: string } | null;
  optOutAt: string | null;
}

export interface WindowState {
  open: boolean;
  closesAt: string | null;
}

export interface InboxItem {
  id: string;
  contact: ContactSummary;
  mode: "bot" | "human";
  humanUntil: string | null;
  lastMessageAt: string | null;
  window: WindowState;
  lastMessage: {
    direction: "inbound" | "outbound";
    type: string;
    author: "contact" | "bot" | "human";
    snippet: string | null;
    status: string;
    at: string;
  } | null;
}

export interface ConversationHeader {
  id: string;
  contact: ContactSummary & {
    optOutSource: string | null;
    optInAt: string | null;
    optInSource: string | null;
  };
  mode: "bot" | "human";
  humanUntil: string | null;
  modeChangedAt: string | null;
  lastChange: { reason: string; at: string; by: string | null } | null;
  window: WindowState;
}

export interface ChatMedia {
  id: string;
  mimeType: string;
  filename: string | null;
  sizeBytes: number | null;
  status: "pending" | "stored" | "skipped" | "rejected" | "failed";
  rejectReason: string | null;
}

export interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  author: "contact" | "bot" | "human";
  authorName: string | null;
  purpose: string | null;
  text: string | null;
  transcript: string | null;
  status: string;
  errorCode: string | null;
  revokedAt: string | null;
  editedAt: string | null;
  at: string;
  media: ChatMedia | null;
}

export interface OptedOutContact extends ContactSummary {
  optOutSource: string | null;
  conversationId: string | null;
  lastOptOut: {
    method: string;
    keyword: string | null;
    note: string | null;
    by: string | null;
  } | null;
}
