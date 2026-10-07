"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, useRef } from "react";
import { ApiError } from "@/lib/api-client";
import { useDemoInfo } from "@/features/demo/hooks";
import { storeLocaleCookie } from "@/features/locale/hooks";
import { localeToApplyAfterLogin } from "@/i18n/locales";
import { api } from "../api";
import { isLoginValidationKey, loginErrorKey, loginSchema } from "../schemas";

/** Only same-app paths are followed after login (no open redirect). */
function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("auth");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Until React hydrates, the button stays disabled: a native (pre-JS) submit would send the
  // credentials in the URL query string (history, logs).
  const [hydrated, setHydrated] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  // Public demo (DEMO_MODE): its operator credentials are public by design (phase 9 M8).
  const demo = useDemoInfo();
  useEffect(() => setHydrated(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = loginSchema.safeParse({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (!parsed.success) {
      const key = parsed.error.issues[0]?.message;
      setError(t(`validation.${isLoginValidationKey(key) ? key : "checkFields"}`));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const session = await api.login(parsed.data.email, parsed.data.password);
      const target = safeNext(params.get("next"));
      // Phase 13: the language saved in the profile wins over this browser's; a full load
      // re-renders the panel in it (the access token is recovered by the silent refresh).
      const saved = localeToApplyAfterLogin(session.user.locale, locale);
      if (saved) {
        storeLocaleCookie(saved);
        window.location.assign(target);
        return;
      }
      router.replace(target);
    } catch (err) {
      setError(t(`errors.${loginErrorKey(err instanceof ApiError ? err.code : "UNKNOWN")}`));
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      method="post"
      onSubmit={onSubmit}
      className="flex w-full max-w-sm flex-col gap-4"
      noValidate
    >
      {demo.data ? (
        <div className="flex flex-col gap-2 rounded-md border-[1.5px] border-foreground bg-card p-3 text-sm text-card-foreground">
          <p>
            <strong>{t("demoTitle")}</strong> {t("demoIntro")}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt>{t("email")}</dt>
            <dd className="font-mono break-all">{demo.data.operator.email}</dd>
            <dt>{t("password")}</dt>
            <dd className="font-mono break-all">{demo.data.operator.password}</dd>
          </dl>
          <button
            type="button"
            className="min-h-11 self-start rounded-md border-[1.5px] border-input px-3 py-2 font-medium hover:bg-muted"
            onClick={() => {
              const form = formRef.current;
              if (!form || !demo.data) return;
              (form.elements.namedItem("email") as HTMLInputElement).value =
                demo.data.operator.email;
              (form.elements.namedItem("password") as HTMLInputElement).value =
                demo.data.operator.password;
            }}
          >
            {t("useThese")}
          </button>
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        {t("email")}
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="min-h-11 rounded-md border-[1.5px] border-input bg-card px-3 py-2 text-base text-card-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("password")}
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="min-h-11 rounded-md border-[1.5px] border-input bg-card px-3 py-2 text-base text-card-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || !hydrated}
        className="min-h-11 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
