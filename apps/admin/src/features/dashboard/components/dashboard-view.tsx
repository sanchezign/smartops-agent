"use client";

import {
  AlertTriangle,
  Bot,
  ClipboardCheck,
  Filter,
  MessageSquare,
  UserRound,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api";
import { formatInt, formatRatio, formatUsd } from "@/lib/format";
import { PREFILTER_RULE_LABEL, type DashboardData } from "../types";
import { DailyBars } from "./daily-bars";
import { StatCard } from "./stat-card";

const PERIODS = [7, 14, 30] as const;

export function DashboardView() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(14);
  const query = useApiQuery<DashboardData>(["dashboard", days], `/admin/dashboard?days=${days}`);

  return (
    <>
      <PageHeader
        title="Inicio"
        description="Cómo viene la operación: mensajes, automatización, costo de IA y lo que espera por vos."
        actions={
          <div role="group" aria-label="Período" className="inline-flex rounded-lg border p-1">
            {PERIODS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={days === p ? "secondary" : "ghost"}
                aria-pressed={days === p}
                onClick={() => setDays(p)}
                className="min-h-9"
              >
                {p} días
              </Button>
            ))}
          </div>
        }
      />
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <DashboardContent data={query.data} />
      )}
    </>
  );
}

function DashboardContent({ data }: { data: DashboardData }) {
  const messages = data.messages.reduce((sum, d) => sum + d.count, 0);
  const errors =
    data.errors.failedWebhooks +
    data.errors.failedDeliveries +
    data.errors.failedRuns +
    data.errors.failedOutbound;
  const finished = data.runs.automatic + data.runs.neededPerson + data.runs.failed;

  return (
    <div className="flex flex-col gap-4">
      {/* What needs a person now */}
      <section aria-label="Pendientes" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Revisiones pendientes"
          value={formatInt(data.pending.reviews)}
          icon={ClipboardCheck}
          href="/revisiones"
          tone={data.pending.reviews > 0 ? "attention" : "default"}
        />
        <StatCard
          label="Alertas abiertas"
          value={formatInt(data.pending.openAlerts)}
          icon={AlertTriangle}
          href="/alertas"
          tone={data.pending.openAlerts > 0 ? "attention" : "default"}
        />
        <StatCard
          label="Chats atendidos por una persona"
          value={formatInt(data.pending.humanConversations)}
          icon={UserRound}
          href="/conversaciones"
        />
        <StatCard
          label="Errores del período"
          value={formatInt(errors)}
          hint={
            data.errors.openIntegrationAlerts > 0
              ? `${data.errors.openIntegrationAlerts} de integración sin revisar`
              : "Webhooks, entregas a n8n, corridas y envíos"
          }
          icon={AlertTriangle}
          tone={errors > 0 ? "danger" : "default"}
        />
      </section>

      <section aria-label="Automatización" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Mensajes recibidos"
          value={formatInt(messages)}
          hint={`Últimos ${data.days} días`}
          icon={MessageSquare}
        />
        <StatCard
          label="Resuelto sin intervención"
          value={formatRatio(data.runs.automationRate)}
          hint={
            finished > 0
              ? `${formatInt(data.runs.automatic)} de ${formatInt(finished)} mensajes procesados`
              : "Todavía no hay mensajes procesados"
          }
          icon={Bot}
        />
        <StatCard
          label="Filtrado sin IA"
          value={formatInt(data.prefilter.total)}
          hint={`Ahorro estimado ${formatUsd(data.prefilter.savedUsd)}`}
          icon={Filter}
        />
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Mensajes por día</h2>
            </CardTitle>
            <CardDescription>Todo lo que llegó por WhatsApp</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyBars
              label="Mensajes"
              color="var(--chart-1)"
              data={data.messages.map((d) => ({ day: d.day, value: d.count }))}
              format={(v) => formatInt(v)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Costo de IA por día (US$)</h2>
            </CardTitle>
            <CardDescription>
              Hoy (UTC) {formatUsd(data.ai.todayUsd)} de {formatUsd(data.ai.budgetDailyUsd)} · Total{" "}
              {formatUsd(data.ai.totalUsd)} de {formatUsd(data.ai.budgetTotalUsd)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyBars
              label="Costo de IA"
              color="var(--chart-2)"
              data={data.ai.byDay.map((d) => ({ day: d.day, value: Number(d.usd) }))}
              format={(v) => formatUsd(v.toFixed(4))}
              axisFormat={(v) => (v === 0 ? "0" : v.toFixed(3).replace(".", ","))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex items-center gap-2">
              <Wallet className="size-4" aria-hidden /> Qué se resolvió sin llamar a la IA
            </h2>
          </CardTitle>
          <CardDescription>
            Mensajes que el filtro previo clasificó solo, sin gastar créditos de Claude.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.prefilter.byRule.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nada todavía en este período.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {data.prefilter.byRule.map((r) => (
                <li
                  key={r.rule}
                  className="flex min-h-11 items-center justify-between gap-3 text-sm"
                >
                  <span>{PREFILTER_RULE_LABEL[r.rule] ?? r.rule}</span>
                  <span className="font-medium tabular-nums">{formatInt(r.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
