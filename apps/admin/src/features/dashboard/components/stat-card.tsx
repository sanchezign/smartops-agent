import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One figure of the Home (phase 14, ADR-029). Tones:
 * - "attention": something waits for a person → the ONLY yellow tile, framed in ink so it is
 *   visible on a light page too;
 * - "danger": errors → red frame and figure (never yellow);
 * - "default": graphite on a framed card.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  tone = "default",
  hintOnPhone = true,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: LucideIcon;
  href?: string;
  tone?: "default" | "attention" | "danger";
  /** false: the hint waits for tablets and up (the phone's first screen holds the pending four). */
  hintOnPhone?: boolean;
}) {
  const lit = tone === "attention";
  const body = (
    <div
      className={cn(
        "flex h-full flex-col gap-1 rounded-lg border-[1.5px] p-3 transition-colors sm:p-4",
        lit
          ? "border-signal-foreground bg-signal text-signal-foreground dark:border-signal"
          : tone === "danger"
            ? "border-destructive bg-card text-card-foreground"
            : "border-border bg-card text-card-foreground",
        href && !lit && "hover:border-foreground",
        href && lit && "hover:brightness-95",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("text-sm", lit ? "font-medium" : "text-muted-foreground")}>
          {label}
        </span>
        <Icon
          className={cn("size-5 shrink-0", tone === "danger" && "text-destructive")}
          aria-hidden
        />
      </div>
      <span
        className={cn(
          "font-display text-3xl tabular-nums",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </span>
      {hint ? (
        <span
          className={cn(
            !hintOnPhone && "hidden sm:block",
            "text-xs",
            lit ? "text-signal-foreground" : "text-muted-foreground",
          )}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {body}
    </Link>
  ) : (
    body
  );
}
