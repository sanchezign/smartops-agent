"use client";

import { AlertTriangle, Inbox, Lock, RefreshCw, SearchX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDemoInfo } from "@/features/demo/hooks";
import { ApiError } from "@/lib/api-client";

/**
 * The same four states on every screen (phase 9): loading, empty, error, forbidden.
 * Screen readers are told what is happening (role=status / role=alert).
 */

export function LoadingState({ rows = 3, label }: { rows?: number; label?: string }) {
  const t = useTranslations("common");
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{label ?? t("loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = <Inbox className="size-8" aria-hidden />,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border-[1.5px] border-dashed px-6 py-12 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ForbiddenState() {
  const t = useTranslations("states");
  return (
    <EmptyState
      icon={<Lock className="size-8" aria-hidden />}
      title={t("forbiddenTitle")}
      description={t("forbiddenDescription")}
    />
  );
}

/**
 * A 404 on a detail screen: the thing is gone (a demo reset or re-seed changes ids, or it was
 * resolved elsewhere) — not a "momentary problem" (user, phase 9 phone tests).
 */
export function NotFoundState({ back }: { back?: { href: string; label: string } }) {
  const t = useTranslations("states");
  const tCommon = useTranslations("common");
  const demo = useDemoInfo().data;
  const target = back ?? { href: "/", label: tCommon("backHome") };
  return (
    <EmptyState
      icon={<SearchX className="size-8" aria-hidden />}
      title={demo ? t("goneTitleDemo") : t("goneTitle")}
      description={t("goneDescription")}
      action={
        <Button asChild variant="outline" className="min-h-11">
          <Link href={target.href}>{target.label}</Link>
        </Button>
      }
    />
  );
}

export function ErrorState({
  error,
  onRetry,
  back,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Where a 404 sends the person back (detail screens). */
  back?: { href: string; label: string };
}) {
  const t = useTranslations("states");
  const tCommon = useTranslations("common");
  if (error instanceof ApiError && error.status === 403) return <ForbiddenState />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState back={back} />;
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border-[1.5px] border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
    >
      <AlertTriangle className="size-8 text-destructive" aria-hidden />
      <p className="font-medium">{t("errorTitle")}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {requestId
          ? t.rich("errorDescriptionWithCode", {
              requestId,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })
          : t("errorDescription")}
      </p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden /> {tCommon("retry")}
        </Button>
      ) : null}
    </div>
  );
}
