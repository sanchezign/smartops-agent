import { FileSpreadsheet, FileText, Image as ImageIcon, MessageSquare, Mic } from "lucide-react";
import type { SourceKind } from "./source";

/** The icon of a kind of message (phase 15). Decorative: the kind is always written next to it. */
const ICONS = {
  audio: Mic,
  image: ImageIcon,
  spreadsheet: FileSpreadsheet,
  document: FileText,
  text: MessageSquare,
} as const;

export function SourceIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon className={className ?? "size-4 shrink-0 text-muted-foreground"} aria-hidden />;
}
