"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState } from "@/components/states";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";
import { digestItemView, type DigestItemView } from "../item-text";
import { isPanelPath } from "../paths";

interface DigestItem {
  category: string;
  title: string;
  data?: unknown;
  createdAt: string;
  path: string | null;
}

/**
 * /d/<token> — the link at the end of each WhatsApp digest (phase 9 M7). Behind the login (the
 * AuthGate keeps this URL as `next`). One item → straight to the screen that resolves it;
 * several → the list, each with its link.
 */
export function DigestView({ token }: { token: string }) {
  const router = useRouter();
  const t = useTranslations("digest");
  const format = useFormat();
  const { formatDateTime } = format;
  const tItems = useTranslations("digest.items");
  const tAlerts = useTranslations("alerts.titles");
  const describe = (view: DigestItemView): string => {
    switch (view.kind) {
      case "run": {
        const parts = [
          view.increases > 0
            ? view.over > 0
              ? tItems("increasesOver", {
                  count: view.increases,
                  over: view.over,
                  threshold: format.formatPct(view.thresholdPct).replace(/^[+−]/, ""),
                })
              : tItems("increases", { count: view.increases })
            : null,
          view.lowStock > 0 ? tItems("lowStock", { count: view.lowStock }) : null,
          view.reviews > 0 ? tItems("reviews", { count: view.reviews }) : null,
        ].filter(Boolean);
        return tItems("run", {
          supplier: view.supplier ?? tItems("processedList"),
          summary: parts.join(", "),
        });
      }
      case "order":
      case "query":
        return tItems(view.kind, {
          name: view.name ?? tItems("aContact"),
          preview: view.preview,
        });
      case "error":
        return tItems("error", { source: view.source, message: view.message });
      case "audio": {
        const limit =
          view.maxSeconds === null ? "?" : format.formatInt(Math.round(view.maxSeconds / 60));
        if (view.seconds !== null) {
          const s = Math.round(view.seconds);
          return tAlerts("audioTooLong", {
            length: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
            limit,
          });
        }
        return tAlerts("audioTooLongSize", {
          size:
            view.sizeBytes === null
              ? "?"
              : format.formatNumber(view.sizeBytes / 1024 / 1024, { maximumFractionDigits: 1 }),
          limit,
        });
      }
    }
  };
  const query = useApiQuery<{
    digest: { createdAt: string; sentAt: string | null; items: DigestItem[] };
  }>(["digest", token], `/admin/digests/${encodeURIComponent(token)}`);
  const items = query.data?.digest.items ?? [];
  const only = items.length === 1 && isPanelPath(items[0]!.path) ? items[0]!.path : null;

  useEffect(() => {
    if (only) router.replace(only);
  }, [only, router]);

  if (query.isPending || only) return <LoadingState rows={3} label={t("opening")} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        back={{ href: "/", label: t("goHome") }}
      />
    );
  }
  const digest = query.data.digest;
  const text = (item: DigestItem) => {
    const view = digestItemView(item.data);
    return view ? describe(view) : item.title;
  };
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description", {
          when: formatDateTime(digest.sentAt ?? digest.createdAt),
        })}
      />
      <ul className="flex flex-col divide-y rounded-xl border bg-card" aria-label={t("itemsLabel")}>
        {digest.items.map((item, i) => (
          <li key={`${item.createdAt}-${i}`}>
            {isPanelPath(item.path) ? (
              <Link
                href={item.path}
                className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 break-words">{text(item)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            ) : (
              <p className="px-4 py-3">{text(item)}</p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
