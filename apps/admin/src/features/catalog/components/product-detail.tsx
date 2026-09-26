"use client";

import { ArrowLeft, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  TIME_ZONE,
  formatDateTime,
  formatInt,
  formatMoney,
  formatNumber,
  formatPct,
} from "@/lib/format";
import { useProduct } from "../hooks";
import { chartPoints } from "../price-chart";
import type { PriceHistoryEntry, ProductDetail as Product } from "../types";

const shortDate = new Intl.DateTimeFormat("es-UY", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
});

export function ProductDetail({ id }: { id: string }) {
  const query = useProduct(id);
  return (
    <div className="mx-auto max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href="/catalogo">
          <ArrowLeft aria-hidden /> Catálogo
        </Link>
      </Button>
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Body product={query.data.product} />
      )}
    </div>
  );
}

function Body({ product }: { product: Product }) {
  const points = chartPoints(product);
  const config = { price: { label: "Precio", color: "var(--chart-2)" } } satisfies ChartConfig;
  return (
    <>
      <header className="mb-5 flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[product.supplier.name, product.unit, product.sku ? `código ${product.sku}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {formatMoney(product.price, product.currency)}
          </span>
          {product.supplier.taxIncluded !== null ? (
            <Badge variant="outline">{product.supplier.taxIncluded ? "con IVA" : "sin IVA"}</Badge>
          ) : null}
          <Badge variant={product.available ? "secondary" : "outline"}>
            {product.available ? "Disponible" : "No disponible"}
          </Badge>
          {product.stock !== null ? (
            <Badge variant="outline">Stock {formatInt(product.stock)}</Badge>
          ) : null}
        </div>
      </header>

      <Card className="mb-5">
        <CardHeader>
          <CardTitle>
            <h2>Historial de precios</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {points.length >= 2 ? (
            <ChartContainer config={config} className="h-56 w-full" aria-hidden>
              <LineChart
                data={points}
                margin={{ left: 0, right: 8, top: 8 }}
                accessibilityLayer={false}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tickFormatter={(v: number) => shortDate.format(new Date(v))}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => formatNumber(v, { maximumFractionDigits: 2 })}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        shortDate.format(new Date(Number(payload?.[0]?.payload?.at)))
                      }
                      formatter={(value) => formatMoney(String(value), product.currency)}
                    />
                  }
                />
                <Line
                  dataKey="price"
                  type="stepAfter"
                  stroke="var(--color-price)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <p className="text-sm text-muted-foreground">
              Todavía no hay cambios de precio para graficar.
            </p>
          )}
          <HistoryList history={product.history} />
        </CardContent>
      </Card>
    </>
  );
}

/** The same data as the chart, readable by everyone (newest first). */
function HistoryList({ history }: { history: PriceHistoryEntry[] }) {
  if (history.length === 0) return null;
  return (
    <ol className="mt-4 flex flex-col divide-y" aria-label="Cambios de precio">
      {[...history].reverse().map((h) => (
        <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <div className="flex flex-col">
            <span className="font-medium tabular-nums">
              {h.oldPrice && h.oldCurrency
                ? `${formatMoney(h.oldPrice, h.oldCurrency)} → `
                : "Precio inicial "}
              {formatMoney(h.newPrice, h.newCurrency)}
            </span>
            <span className="text-muted-foreground">
              {formatDateTime(h.createdAt)} ·{" "}
              {h.source === "review" ? "aprobado en revisión" : "automático"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {h.currencyChanged ? (
              <Badge variant="secondary">Cambió la moneda</Badge>
            ) : h.changePct ? (
              <Badge variant="secondary" className="tabular-nums">
                {formatPct(h.changePct)}
              </Badge>
            ) : null}
            {h.conversationId ? (
              <Link
                href={`/conversaciones/${h.conversationId}`}
                className="inline-flex min-h-9 items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
                aria-label="Ver el mensaje que lo cambió"
              >
                <MessagesSquare className="size-4" aria-hidden /> Mensaje
              </Link>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
