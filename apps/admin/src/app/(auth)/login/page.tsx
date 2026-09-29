import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/features/auth/components/login-form";
import { LocaleSelect } from "@/features/locale/components/locale-select";

export const metadata: Metadata = { title: "Ingresar" };

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <LocaleSelect className="absolute right-4 top-4" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold">SmartOps</h1>
        <p className="text-sm text-neutral-500">Panel de operaciones</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
