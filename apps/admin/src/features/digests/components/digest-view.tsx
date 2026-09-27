"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState } from "@/components/states";
import { useApiQuery } from "@/hooks/use-api";
import { formatDateTime } from "@/lib/format";
import { isPanelPath } from "../paths";

interface DigestItem {
  category: string;
  title: string;
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
  const query = useApiQuery<{
    digest: { createdAt: string; sentAt: string | null; items: DigestItem[] };
  }>(["digest", token], `/admin/digests/${encodeURIComponent(token)}`);
  const items = query.data?.digest.items ?? [];
  const only = items.length === 1 && isPanelPath(items[0]!.path) ? items[0]!.path : null;

  useEffect(() => {
    if (only) router.replace(only);
  }, [only, router]);

  if (query.isPending || only) return <LoadingState rows={3} label="Abriendo el resumen…" />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        back={{ href: "/", label: "Ir al inicio" }}
      />
    );
  }
  const digest = query.data.digest;
  return (
    <>
      <PageHeader
        title="Resumen de WhatsApp"
        description={`Enviado ${formatDateTime(digest.sentAt ?? digest.createdAt)}. Tocá cada punto para resolverlo.`}
      />
      <ul
        className="flex flex-col divide-y rounded-xl border bg-card"
        aria-label="Puntos del resumen"
      >
        {digest.items.map((item, i) => (
          <li key={`${item.createdAt}-${i}`}>
            {isPanelPath(item.path) ? (
              <Link
                href={item.path}
                className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 break-words">{item.title}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            ) : (
              <p className="px-4 py-3">{item.title}</p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
