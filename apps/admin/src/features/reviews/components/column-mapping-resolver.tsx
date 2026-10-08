"use client";

import { AlertTriangle, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { InputError } from "@/lib/number-input";
import { useFormat } from "@/lib/use-format";
import { useInputErrorText } from "@/lib/use-input-error";
import type { ResolveInput } from "../hooks";
import { columnMappingApproveBody, initialPriceColumns } from "../resolve-input";
import type { ColumnMappingProposal, PriceColumn, ReviewItem, TableProposal } from "../types";
import { ResolveActions } from "./resolve-actions";
import { Section } from "./section";

function taxKey(value: boolean | null): "withVat" | "withoutVat" | null {
  if (value === true) return "withVat";
  if (value === false) return "withoutVat";
  return null;
}

type ColumnKind = PriceColumn["kind"];

/**
 * New spreadsheet format: the person picks WHICH price column the catalog uses. Each option
 * shows real values from the file. The model's recommendation is only pre-selected; nothing is
 * saved until the person approves. Approving remembers the format for this supplier: the next
 * spreadsheets with the same header are read without AI.
 */
export function ColumnMappingResolver({
  item,
  readOnly,
  pending,
  onResolve,
}: {
  item: ReviewItem;
  readOnly: boolean;
  pending: boolean;
  onResolve(input: ResolveInput): void;
}) {
  const proposal = item.proposal as ColumnMappingProposal;
  const [chosen, setChosen] = useState(() => initialPriceColumns(proposal));
  const [error, setError] = useState<InputError | null>(null);
  const t = useTranslations("reviews.columns");
  const errorText = useInputErrorText();
  const tables = proposal.tables.filter((t) => !t.remembered && t.isPriceTable);

  return (
    <>
      {proposal.suspiciousInstructions ? (
        <p className="mb-4 flex gap-2 rounded-lg border-[1.5px] border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
          {t("suspicious")}
        </p>
      ) : null}
      {tables.map((table) => (
        <TableChoice
          key={table.table}
          table={table}
          value={chosen[table.table] ?? null}
          readOnly={readOnly}
          onChange={(column) => setChosen((c) => ({ ...c, [table.table]: column }))}
        />
      ))}
      {proposal.warnings.length ? (
        <Section title={t("notes")}>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {proposal.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {readOnly ? null : (
        <ResolveActions
          approveLabel={t("approve")}
          rejectLabel={t("reject")}
          pending={pending}
          error={error ? errorText(error) : null}
          onApprove={() => {
            const result = columnMappingApproveBody(proposal, chosen);
            if (!result.ok) return setError(result.error);
            setError(null);
            onResolve({ action: "approve", body: result.body });
          }}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}

function TableChoice({
  table,
  value,
  readOnly,
  onChange,
}: {
  table: TableProposal;
  value: number | null;
  readOnly: boolean;
  onChange(column: number): void;
}) {
  const t = useTranslations("reviews.columns");
  const { formatPrice } = useFormat();
  const columns = table.mapping.priceColumns;
  const sample = table.preview.slice(0, 3);
  return (
    <Section title={t("sheetQuestion", { sheet: table.sheet })}>
      <RadioGroup
        value={value === null ? "" : String(value)}
        onValueChange={(v) => onChange(Number(v))}
        disabled={readOnly}
        aria-label={t("sheetLabel", { sheet: table.sheet })}
        className="grid gap-2 sm:grid-cols-2"
      >
        {columns.map((col) => {
          const key = col.header || `C${col.column}`;
          const tax = taxKey(col.taxIncluded);
          return (
            <Label
              key={col.column}
              className="flex cursor-pointer items-start gap-3 rounded-lg border-[1.5px] p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50"
            >
              <RadioGroupItem value={String(col.column)} className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium before:content-['“'] after:content-['”']">
                    {col.header || t("columnN", { n: col.column + 1 })}
                  </span>
                  {table.recommendedPriceColumn === col.column ? (
                    <Badge variant="secondary">
                      <Sparkles aria-hidden /> {t("suggested")}
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t(`kinds.${col.kind satisfies ColumnKind}`)}
                  {tax ? ` · ${t(tax)}` : ""}
                </span>
                <span className="flex flex-col text-xs font-normal">
                  {sample.map((row) => (
                    <span key={row.name} className="flex justify-between gap-3">
                      <span className="truncate text-muted-foreground">{row.name}</span>
                      <span className="font-mono tabular-nums">
                        {row.prices[key] ? formatPrice(row.prices[key]) : "—"}
                      </span>
                    </span>
                  ))}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{t("remembered")}</p>
    </Section>
  );
}
