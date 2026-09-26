"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/store";

const ROLE_LABEL = { admin: "Administrador", operator: "Operador" } as const;

/** Minimal home (phase 8): proves the session; the real panel screens arrive in phase 9. */
export default function Home() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);

  async function logout() {
    await api.logout();
    router.replace("/login");
  }

  async function logoutAll() {
    const sessions = await api.logoutAll();
    setNote(`Se cerraron ${sessions} sesiones.`);
    router.replace("/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">SmartOps</h1>
      <p className="text-sm">
        Hola, {user?.name} · {user ? ROLE_LABEL[user.role] : ""}
      </p>
      <p className="text-sm text-neutral-500">Las pantallas del panel llegan en la fase 9.</p>
      <div className="flex gap-3">
        <button onClick={logout} className="rounded-md border border-neutral-300 px-3 py-2 text-sm">
          Cerrar sesión
        </button>
        <button
          onClick={logoutAll}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          Cerrar todas mis sesiones
        </button>
      </div>
      {note ? <p className="text-sm text-neutral-500">{note}</p> : null}
    </main>
  );
}
