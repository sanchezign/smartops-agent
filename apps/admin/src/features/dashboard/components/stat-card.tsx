import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: LucideIcon;
  href?: string;
  tone?: "default" | "attention" | "danger";
}) {
  const body = (
    <Card
      className={cn(
        "h-full transition-colors",
        href && "hover:border-foreground/30",
        tone === "attention" && "border-amber-500/40",
        tone === "danger" && "border-destructive/40",
      )}
    >
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        <Icon
          className={cn(
            "size-5 shrink-0 text-muted-foreground",
            tone === "attention" && "text-amber-600 dark:text-amber-400",
            tone === "danger" && "text-destructive",
          )}
          aria-hidden
        />
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:outline-2">
      {body}
    </Link>
  ) : (
    body
  );
}
