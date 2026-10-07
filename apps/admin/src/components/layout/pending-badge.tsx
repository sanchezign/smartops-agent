import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * How many things of a section wait for a person (ADR-029): the yellow of the navigation. Framed
 * in ink on light pages (the yellow alone has no 3:1 edge there). Nothing is drawn for zero.
 */
export function PendingBadge({ count, className }: { count: number; className?: string }) {
  const t = useTranslations("shell");
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full border-[1.5px] border-signal-foreground bg-signal px-1.5 text-xs leading-4 font-bold text-signal-foreground dark:border-signal",
        className,
      )}
    >
      <span aria-hidden>{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{t("pendingCount", { count })}</span>
    </span>
  );
}
