import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("errorPage");
  const tCommon = await getTranslations("common");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="font-display text-xl">{t("notFoundTitle")}</h1>
      <Link href="/" className="text-sm underline underline-offset-4">
        {tCommon("backHome")}
      </Link>
    </main>
  );
}
