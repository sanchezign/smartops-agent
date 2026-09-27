"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, useRef } from "react";
import { ApiError } from "@/lib/api-client";
import { useDemoInfo } from "@/features/demo/hooks";
import { api } from "../api";
import { loginErrorText, loginSchema } from "../schemas";

/** Only same-app paths are followed after login (no open redirect). */
function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
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
      setError(parsed.error.issues[0]?.message ?? "Revisá los datos.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.login(parsed.data.email, parsed.data.password);
      router.replace(safeNext(params.get("next")));
    } catch (err) {
      setError(loginErrorText(err instanceof ApiError ? err.code : "UNKNOWN"));
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
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
          <p>
            <strong>Demo pública.</strong> Entrá como operador con estos datos (son públicos):
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt>Email</dt>
            <dd className="font-mono break-all">{demo.data.operator.email}</dd>
            <dt>Contraseña</dt>
            <dd className="font-mono break-all">{demo.data.operator.password}</dd>
          </dl>
          <button
            type="button"
            className="self-start rounded-md border border-amber-700/40 px-3 py-2 font-medium"
            onClick={() => {
              const form = formRef.current;
              if (!form || !demo.data) return;
              (form.elements.namedItem("email") as HTMLInputElement).value =
                demo.data.operator.email;
              (form.elements.namedItem("password") as HTMLInputElement).value =
                demo.data.operator.password;
            }}
          >
            Usar estos datos
          </button>
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="rounded-md border border-neutral-300 px-3 py-2 text-base"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Contraseña
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-neutral-300 px-3 py-2 text-base"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || !hydrated}
        className="rounded-md bg-neutral-900 px-3 py-2 text-white disabled:opacity-60"
      >
        {pending ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
