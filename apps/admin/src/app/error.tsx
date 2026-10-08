"use client";

import { useTranslations } from "next-intl";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  const tCommon = useTranslations("common");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="font-display text-xl">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <button
        onClick={reset}
        className="min-h-11 rounded-md border-[1.5px] border-input px-3 py-2 text-sm"
      >
        {tCommon("retry")}
      </button>
    </main>
  );
}
