import { formatTime } from "@/lib/format";
import type { ChatMessage, ContactSummary, InboxFilter } from "./types";

export const FILTER_LABEL: Record<InboxFilter, string> = {
  all: "Todas",
  human: "Atiende una persona",
  suppliers: "Proveedores",
  customers: "Clientes",
  opted_out: "Dados de baja",
};

export type WhoAnswers = "bot" | "human" | "opted_out";

/**
 * Who answers this chat (the badge). An opted-out contact wins: the bot sends it nothing,
 * whatever the mode says (ADR-017).
 */
export function whoAnswers(input: {
  mode: "bot" | "human";
  contact: Pick<ContactSummary, "optOutAt">;
}): WhoAnswers {
  if (input.contact.optOutAt) return "opted_out";
  return input.mode;
}

export const WHO_LABEL: Record<WhoAnswers, { emoji: string; text: string }> = {
  bot: { emoji: "🤖", text: "Responde el bot" },
  human: { emoji: "👤", text: "Atiende una persona" },
  opted_out: { emoji: "⛔", text: "Dado de baja" },
};

export function humanUntilText(humanUntil: string | null): string {
  return humanUntil ? `hasta las ${formatTime(humanUntil)}` : "hasta que lo reactives";
}

export function contactName(contact: Pick<ContactSummary, "name" | "waId" | "username">): string {
  return contact.name ?? contact.username ?? (contact.waId ? `+${contact.waId}` : "Contacto");
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The supplier name, unless the contact is already called like it ("Eléctrica Oriental"). */
export function supplierSuffix(contact: Pick<ContactSummary, "name" | "supplier">): string | null {
  if (!contact.supplier) return null;
  const name = contact.name ? fold(contact.name) : "";
  return name && fold(contact.supplier.name).startsWith(name) ? null : contact.supplier.name;
}

export const KIND_LABEL: Record<ContactSummary["kind"], string> = {
  supplier: "Proveedor",
  customer: "Cliente",
  internal: "Equipo",
  unknown: "Sin clasificar",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Enviando…",
  sent: "Enviado",
  delivered: "Entregado",
  read: "Leído",
  failed: "No se pudo enviar",
  canceled: "Cancelado (atendía una persona)",
};

const TYPE_TEXT: Record<string, string> = {
  image: "📷 Foto",
  audio: "🎤 Audio",
  document: "📄 Documento",
  video: "🎬 Video",
  sticker: "Sticker",
  location: "📍 Ubicación",
  contacts: "👤 Contacto",
  reaction: "Reacción",
};

/** Text for the inbox preview line. */
export function previewText(message: { type: string; snippet: string | null }): string {
  return message.snippet ?? TYPE_TEXT[message.type] ?? "Mensaje";
}

/** Who wrote an outbound message, for the bubble. */
export function outboundAuthor(
  message: Pick<ChatMessage, "author" | "authorName" | "purpose">,
): string {
  if (message.purpose === "compliance") return "🤖 Confirmación automática";
  if (message.author === "bot") return "🤖 Bot";
  return `👤 ${message.authorName ?? "Persona (desde el teléfono)"}`;
}

export const MEDIA_UNAVAILABLE: Record<string, string> = {
  pending: "Descargando de WhatsApp…",
  skipped: "No se descarga este tipo de archivo",
  rejected: "Archivo rechazado (tipo o tamaño no permitido)",
  failed: "No se pudo descargar de WhatsApp",
};
