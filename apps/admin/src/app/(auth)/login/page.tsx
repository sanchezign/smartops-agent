import { pageMetadata } from "@/i18n/metadata";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LoginForm } from "@/features/auth/components/login-form";
import { LocaleSelect } from "@/features/locale/components/locale-select";

export const generateMetadata = pageMetadata("login");

export default async function LoginPage() {
  const t = await getTranslations("auth");
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <LocaleSelect className="absolute right-4 top-4" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold">SmartOps</h1>
        <p className="text-sm text-neutral-500">{t("subtitle")}</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
