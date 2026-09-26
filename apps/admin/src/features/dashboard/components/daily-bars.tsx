"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatShortDay } from "@/lib/format";

/**
 * A daily bar chart (phase 9). Charts are decorative for screen readers: the same data is in a
 * visually hidden table right after it.
 */
export function DailyBars({
  data,
  label,
  color,
  format,
  axisFormat = format,
}: {
  data: { day: string; value: number }[];
  label: string;
  color: string;
  format: (value: number) => string;
  /** Short axis labels (the tooltip and the table keep the full format). */
  axisFormat?: (value: number) => string;
}) {
  const config = { value: { label, color } } satisfies ChartConfig;
  return (
    <>
      <ChartContainer config={config} className="h-48 w-full" aria-hidden>
        <BarChart
          data={data}
          margin={{ left: 0, right: 4, top: 8 }}
          // The data is in the table below: the chart itself is hidden from assistive tech.
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickFormatter={formatShortDay}
            minTickGap={16}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => axisFormat(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatShortDay(String(value))}
                formatter={(value) => format(Number(value))}
              />
            }
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={4} />
        </BarChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>{label} por día</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatShortDay(d.day)}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
