import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The row every list of the panel shares (phase 14, ADR-029): one separated, framed row per item
 * (Conversations, Catalog, Alerts, Reviews). `emphasis` draws the frame in ink — what waits for a
 * person — never in yellow: when EVERY row of a list waits, yellow would stop meaning anything.
 */
const ROW =
  "flex min-h-16 items-center gap-3 rounded-lg border-[1.5px] bg-card px-4 py-3 text-card-foreground";

export function rowClass(emphasis = false, interactive = true) {
  return cn(
    ROW,
    emphasis ? "border-foreground" : "border-border",
    interactive &&
      "transition-colors hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  );
}

export function RowLink({
  emphasis,
  className,
  ...props
}: ComponentProps<typeof Link> & { emphasis?: boolean }) {
  return <Link className={cn(rowClass(emphasis), className)} {...props} />;
}

/** A list of rows with space between them (not one box with dividers). */
export function RowList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col gap-2", className)} {...props} />;
}

/** A short fact as a text label (kind of contact, unit…): the words carry it, never only a color. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-[0.7rem] leading-4 font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
