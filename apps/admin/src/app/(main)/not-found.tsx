import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

/** Inside the shell (phase 14 M6): the navigation stays, and the page has its own heading. */
export default async function NotFound() {
  const t = await getTranslations("errorPage");
  const tCommon = await getTranslations("common");
  return (
    <>
      <PageHeader title={t("notFoundTitle")} description={t("notFoundHint")} />
      <Button asChild className="min-h-11">
        <Link href="/">{tCommon("backHome")}</Link>
      </Button>
    </>
  );
}
