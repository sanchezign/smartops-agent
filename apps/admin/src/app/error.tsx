"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-xl font-semibold">Algo salió mal</h1>
      <p className="text-sm text-neutral-500">Probá de nuevo; si sigue pasando, avisá al equipo.</p>
      <button onClick={reset} className="rounded-md border border-neutral-300 px-3 py-2 text-sm">
        Reintentar
      </button>
    </main>
  );
}
