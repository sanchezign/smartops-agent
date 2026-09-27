"use client";

import {
  CheckCircle2,
  Circle,
  CircleDot,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  OctagonAlert,
  PauseCircle,
  RotateCcw,
  ShieldAlert,
  Table2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDemoInfo, useInject, useResetDemo, useTrace } from "../hooks";
import { timeline, type DemoSampleKind } from "../trace";

const SAMPLES: { kind: DemoSampleKind; title: string; detail: string; icon: typeof Mic }[] = [
  {
    kind: "foto",
    title: "Enviar foto de lista de precios",
    detail: "Una foto de una lista impresa: la IA lee los precios y los compara con el catálogo.",
    icon: ImageIcon,
  },
  {
    kind: "pdf",
    title: "Enviar PDF de proveedor",
    detail: "La lista completa de un proveedor en PDF.",
    icon: FileText,
  },
  {
    kind: "audio",
    title: "Enviar audio de proveedor",
    detail: "Una nota de voz: se transcribe y se extrae el precio (si hay dudas, va a revisión).",
    icon: Mic,
  },
  {
    kind: "planilla",
    title: "Enviar planilla conocida",
    detail: "Un Excel con un formato ya aprobado: se lee sin IA y sin costo.",
    icon: FileSpreadsheet,
  },
  {
    kind: "planilla_nueva",
    title: "Enviar planilla nueva",
    detail:
      "Un Excel con un formato que el sistema no conoce: una persona elige la columna de precio.",
    icon: Table2,
  },
  {
    kind: "injection",
    title: "Enviar mensaje con prompt injection",
    detail: "Un mensaje que intenta darle órdenes a la IA: se frena y no toca el catálogo.",
    icon: ShieldAlert,
  },
];

interface Sent {
  kind: DemoSampleKind;
  wamid: string;
  at: string;
}

export function TryView() {
  const info = useDemoInfo();
  const [sent, setSent] = useState<Sent[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const inject = useInject((kind, wamid) =>
    setSent((s) => [{ kind, wamid, at: new Date().toISOString() }, ...s].slice(0, 10)),
  );
  const reset = useResetDemo(() => {
    setSent([]);
    setConfirmReset(false);
  });

  if (info.isPending) return <LoadingState rows={3} />;
  if (!info.data)
    return (
      <EmptyState
        title="Esta página existe solo en la demo pública"
        description="En una instalación real los mensajes llegan por WhatsApp."
      />
    );

  return (
    <>
      <PageHeader
        title="Probar el sistema"
        description="Mandá mensajes de ejemplo como si fueras un proveedor. Recorren el sistema real (sin WhatsApp y sin costo) y ves cada paso en vivo."
        actions={
          <Button variant="outline" className="min-h-11" onClick={() => setConfirmReset(true)}>
            <RotateCcw aria-hidden /> Reiniciar demo
          </Button>
        }
      />
      {info.data.nextResetAt ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Los datos de ejemplo se reinician solos a las {formatTime(info.data.nextResetAt)}.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SAMPLES.map(({ kind, title, detail, icon: Icon }) => (
          <Card key={kind} className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-start gap-2 text-base">
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <h2>{title}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-3">
              <p className="text-sm text-muted-foreground">{detail}</p>
              <Button
                className="min-h-11 w-full"
                disabled={inject.isPending}
                onClick={() => inject.mutate(kind)}
                aria-label={title}
              >
                {inject.isPending && inject.variables === kind ? "Enviando…" : "Enviar"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <section aria-label="Mensajes de prueba enviados" className="mt-6 flex flex-col gap-3">
        {sent.map((s) => (
          <TraceCard key={s.wamid} sent={s} />
        ))}
      </section>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Reiniciar la demo?</DialogTitle>
            <DialogDescription>
              Vuelven los datos de ejemplo del principio: se borran las pruebas y revisiones que
              hiciste. Tu sesión sigue abierta.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setConfirmReset(false)}>
              Cancelar
            </Button>
            <Button className="min-h-11" disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? "Reiniciando…" : "Reiniciar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TraceCard({ sent }: { sent: Sent }) {
  const [finished, setFinished] = useState(false);
  const trace = useTrace(sent.wamid, finished);
  const view = timeline(sent.kind, trace.data ?? null);
  useEffect(() => {
    if (view.finished) setFinished(true);
  }, [view.finished]);
  const title = SAMPLES.find((s) => s.kind === sent.kind)!.title.replace(/^Enviar /, "");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <h3 className="first-letter:uppercase">{title}</h3>
          <span className="text-xs font-normal text-muted-foreground">
            {formatDateTime(sent.at)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex flex-col gap-1.5" aria-label={`Pasos: ${title}`}>
          {view.steps.map((step) => (
            <li key={step.label} className="flex items-center gap-2 text-sm">
              {step.state === "done" ? (
                <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
              ) : step.state === "active" ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              ) : step.state === "held" ? (
                <PauseCircle className="size-4 text-amber-600" aria-hidden />
              ) : step.state === "failed" ? (
                <OctagonAlert className="size-4 text-destructive" aria-hidden />
              ) : (
                <Circle className="size-4 text-muted-foreground/60" aria-hidden />
              )}
              <span className={cn(step.state === "waiting" && "text-muted-foreground")}>
                {step.label}
              </span>
              <span className="sr-only">
                {
                  {
                    done: "(listo)",
                    active: "(en curso)",
                    held: "(frenado para revisión)",
                    failed: "(falló)",
                    waiting: "(pendiente)",
                  }[step.state]
                }
              </span>
            </li>
          ))}
        </ol>
        {view.outcome ? (
          <div
            role="status"
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm",
              view.outcome.tone === "success" &&
                "border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/30",
              view.outcome.tone === "review" &&
                "border-amber-500/40 bg-amber-50 dark:bg-amber-950/30",
              view.outcome.tone === "failed" && "border-destructive/40 bg-destructive/5",
            )}
          >
            <span className="flex items-center gap-2">
              <CircleDot className="size-4 shrink-0" aria-hidden /> {view.outcome.text}
            </span>
            <Link
              href={view.outcome.href}
              className="min-h-9 font-medium underline-offset-4 hover:underline"
            >
              {view.outcome.linkText}
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
