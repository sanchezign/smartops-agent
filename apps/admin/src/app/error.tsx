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
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-neutral-500">{t("description")}</p>
      <button onClick={reset} className="rounded-md border border-neutral-300 px-3 py-2 text-sm">
        {tCommon("retry")}
      </button>
    </main>
  );
}
