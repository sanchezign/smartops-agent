"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

/** A screen that breaks keeps the shell (navigation, language, user menu): phase 14 M6. */
export default function MainError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  const tCommon = useTranslations("common");
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <Button className="min-h-11" onClick={reset}>
        {tCommon("retry")}
      </Button>
    </>
  );
}
