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
import { useTranslations } from "next-intl";
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
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useDemoInfo, useInject, useResetDemo, useTrace } from "../hooks";
import { timeline, type DemoSampleKind } from "../trace";

/** The six samples (texts in "demo.samples.<kind>"). */
const SAMPLES: { kind: DemoSampleKind; icon: typeof Mic }[] = [
  // The suggested path first (phase 14): a new spreadsheet → a person picks the column → the
  // catalog updates. It is the whole product in one minute.
  { kind: "planilla_nueva", icon: Table2 },
  { kind: "foto", icon: ImageIcon },
  { kind: "pdf", icon: FileText },
  { kind: "audio", icon: Mic },
  { kind: "planilla", icon: FileSpreadsheet },
  { kind: "injection", icon: ShieldAlert },
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
  const t = useTranslations("demo");
  const tPages = useTranslations("pages");
  const { formatTime } = useFormat();
  const inject = useInject((kind, wamid) =>
    setSent((s) => [{ kind, wamid, at: new Date().toISOString() }, ...s].slice(0, 10)),
  );
  const reset = useResetDemo(() => {
    setSent([]);
    setConfirmReset(false);
  });

  if (info.isPending) return <LoadingState rows={3} />;
  if (!info.data) return <EmptyState title={t("onlyInDemo")} description={t("onlyInDemoHint")} />;

  return (
    <>
      <PageHeader
        title={tPages("try")}
        description={t("description")}
        actions={
          <Button variant="outline" className="min-h-11" onClick={() => setConfirmReset(true)}>
            <RotateCcw aria-hidden /> {t("reset")}
          </Button>
        }
      />
      {info.data.nextResetAt ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {t("autoReset", { time: formatTime(info.data.nextResetAt) })}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SAMPLES.map(({ kind, icon: Icon }, index) => (
          <Card
            key={kind}
            className={cn(
              "flex flex-col",
              // the suggested sample: ink frame, spans the row on wide screens
              index === 0 && "border-foreground sm:col-span-2 lg:col-span-3",
            )}
          >
            <CardHeader>
              <CardTitle className="flex flex-wrap items-start gap-2 text-base">
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <h2>{t(`samples.${kind}.title`)}</h2>
                {index === 0 ? (
                  <span className="rounded bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                    {t("startHere")}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {t(`samples.${kind}.detail`)}
                {index === 0 ? ` ${t("startHereHint")}` : ""}
              </p>
              <Button
                className="min-h-11 w-full"
                disabled={inject.isPending}
                onClick={() => inject.mutate(kind)}
                aria-label={t(`samples.${kind}.title`)}
              >
                {inject.isPending && inject.variables === kind ? t("sending") : t("send")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <section aria-label={t("sentLabel")} className="mt-6 flex flex-col gap-3">
        {sent.map((s) => (
          <TraceCard key={s.wamid} sent={s} />
        ))}
      </section>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("resetTitle")}</DialogTitle>
            <DialogDescription>{t("resetBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setConfirmReset(false)}>
              {t("cancel")}
            </Button>
            <Button className="min-h-11" disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? t("resetting") : t("resetConfirm")}
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
  const t = useTranslations("demo");
  const { formatDateTime } = useFormat();
  const title = t(`samples.${sent.kind}.short`);
  const outcome = view.outcome;
  const outcomeText = !outcome
    ? null
    : outcome.key === "updated" && outcome.counts
      ? t("outcomes.updated", {
          summary: (["prices", "created", "reviews"] as const)
            .filter((k) => outcome.counts![k] > 0)
            .map((k) => t(`outcomes.${k}`, { count: outcome.counts![k] }))
            .join(", "),
        })
      : t(`outcomes.${outcome.key}`);
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
        <ol className="flex flex-col gap-1.5" aria-label={t("stepsOf", { title })}>
          {view.steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2 text-sm">
              {step.state === "done" ? (
                <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
              ) : step.state === "active" ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              ) : step.state === "held" ? (
                <PauseCircle className="size-4 text-warning" aria-hidden />
              ) : step.state === "failed" ? (
                <OctagonAlert className="size-4 text-destructive" aria-hidden />
              ) : (
                <Circle className="size-4 text-muted-foreground/60" aria-hidden />
              )}
              <span className={cn(step.state === "waiting" && "text-muted-foreground")}>
                {t(`steps.${step.key}`)}
              </span>
              <span className="sr-only">{t(`stepStates.${step.state}`)}</span>
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
              view.outcome.tone === "review" && "border-foreground bg-card",
              view.outcome.tone === "failed" && "border-destructive/40 bg-destructive/5",
            )}
          >
            <span className="flex items-center gap-2">
              <CircleDot className="size-4 shrink-0" aria-hidden /> {outcomeText}
            </span>
            <Link
              href={view.outcome.href}
              className="min-h-9 font-medium underline-offset-4 hover:underline"
            >
              {t(`links.${view.outcome.linkKey}`)}
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
