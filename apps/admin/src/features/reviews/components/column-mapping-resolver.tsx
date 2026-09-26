"use client";

import { AlertTriangle, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { ResolveInput } from "../hooks";
import { columnMappingApproveBody, initialPriceColumns } from "../resolve-input";
import type { ColumnMappingProposal, PriceColumn, ReviewItem, TableProposal } from "../types";
import { ResolveActions } from "./resolve-actions";
import { Section } from "./section";

const KIND_TEXT: Record<PriceColumn["kind"], string> = {
  list: "Precio de lista",
  wholesale: "Mayorista",
  cash: "Contado",
  card: "Tarjeta",
  cost: "Costo",
  other: "Otro precio",
};

function taxText(value: boolean | null): string | null {
  if (value === true) return "con IVA";
  if (value === false) return "sin IVA";
  return null;
}

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
  const [error, setError] = useState<string | null>(null);
  const tables = proposal.tables.filter((t) => !t.remembered && t.isPriceTable);

  return (
    <>
      {proposal.suspiciousInstructions ? (
        <p className="mb-4 flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
          La planilla tiene texto que intenta darle órdenes al sistema. Revisala antes de aprobar.
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
        <Section title="Notas de la lectura">
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {proposal.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {readOnly ? null : (
        <ResolveActions
          approveLabel="Usar esta columna"
          rejectLabel="Descartar la planilla"
          pending={pending}
          error={error}
          onApprove={() => {
            const result = columnMappingApproveBody(proposal, chosen);
            if (!result.ok) return setError(result.message);
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
  const columns = table.mapping.priceColumns;
  const sample = table.preview.slice(0, 3);
  return (
    <Section title={`Hoja "${table.sheet}": ¿qué precio cargamos en el catálogo?`}>
      <RadioGroup
        value={value === null ? "" : String(value)}
        onValueChange={(v) => onChange(Number(v))}
        disabled={readOnly}
        aria-label={`Columna de precio de la hoja ${table.sheet}`}
        className="grid gap-2 sm:grid-cols-2"
      >
        {columns.map((col) => {
          const key = col.header || `C${col.column}`;
          const tax = taxText(col.taxIncluded);
          return (
            <Label
              key={col.column}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50"
            >
              <RadioGroupItem value={String(col.column)} className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">
                    &ldquo;{col.header || `Columna ${col.column + 1}`}&rdquo;
                  </span>
                  {table.recommendedPriceColumn === col.column ? (
                    <Badge variant="secondary">
                      <Sparkles aria-hidden /> Sugerida
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {KIND_TEXT[col.kind]}
                  {tax ? ` · ${tax}` : ""}
                </span>
                <span className="flex flex-col text-xs font-normal">
                  {sample.map((row) => (
                    <span key={row.name} className="flex justify-between gap-3">
                      <span className="truncate text-muted-foreground">{row.name}</span>
                      <span className="font-mono tabular-nums">{row.prices[key] ?? "—"}</span>
                    </span>
                  ))}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        Se recuerda para las próximas planillas de este proveedor con el mismo formato: esas se leen
        sin IA y sin revisión.
      </p>
    </Section>
  );
}
