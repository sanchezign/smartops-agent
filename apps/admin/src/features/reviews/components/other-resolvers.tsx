"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney, formatPct } from "@/lib/format";
import { useSuppliers, type ResolveInput } from "../hooks";
import type {
  GateProposal,
  GlobalChangeProposal,
  MarkUnavailableProposal,
  ReviewItem,
} from "../types";
import { ResolveActions } from "./resolve-actions";
import { Section } from "./section";

interface ResolverProps {
  item: ReviewItem;
  readOnly: boolean;
  pending: boolean;
  onResolve(input: ResolveInput): void;
}

const signed = (pct: string) => formatPct(pct);

/** "Todo sube 8 %": the preview per product; approving applies it where the price did not change since. */
export function GlobalChangeResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = item.proposal as GlobalChangeProposal;
  const outliers = proposal.products.filter((p) => p.outlier).length;
  return (
    <>
      <Section
        title={`Cambio anunciado: ${signed(proposal.pct)} a ${proposal.products.length} productos`}
      >
        {outliers ? (
          <p className="text-sm text-muted-foreground">
            {outliers} {outliers === 1 ? "producto supera" : "productos superan"} el límite de
            cambio configurado.
          </p>
        ) : null}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Antes</TableHead>
                <TableHead className="text-right">Después</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposal.products.map((p) => (
                <TableRow key={p.productId}>
                  <TableCell className="max-w-48 truncate">
                    {p.name}
                    {p.outlier ? (
                      <Badge variant="destructive" className="ml-2">
                        fuera de lo normal
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatMoney(p.oldPrice, p.currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(p.newPrice, p.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
      {readOnly ? null : (
        <ResolveActions
          approveLabel={`Aplicar ${signed(proposal.pct)}`}
          pending={pending}
          onApprove={() => onResolve({ action: "approve", body: {} })}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}

export function MarkUnavailableResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = item.proposal as MarkUnavailableProposal;
  return (
    <>
      <Section title="Producto">
        <p className="text-sm">
          <span className="font-medium">{item.product?.name ?? "Producto"}</span>
          {item.product ? (
            <span className="text-muted-foreground">
              {" "}
              · precio actual {formatMoney(item.product.price, item.product.currency)}
            </span>
          ) : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {proposal.reason === "missing_from_full_list"
            ? "El proveedor mandó su lista completa y este producto no aparece. Puede que ya no lo venda, o que se le haya pasado."
            : "El proveedor dice que no tiene este producto."}{" "}
          Si lo marcás como no disponible, deja de ofrecerse hasta que vuelva a cotizarlo.
        </p>
      </Section>
      {readOnly ? null : (
        <ResolveActions
          approveLabel="Marcar como no disponible"
          rejectLabel="Dejarlo disponible"
          pending={pending}
          onApprove={() => onResolve({ action: "approve", body: {} })}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}

const taxBasis = (v: boolean | null | undefined) =>
  v === true ? "con IVA incluido" : v === false ? "sin IVA" : "sin indicar";

/** Whole-list gates: tax basis change, suspicious instructions, extraction failed. */
export function GateResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = (item.proposal ?? {}) as GateProposal;
  const copy =
    item.kind === "tax_basis_changed"
      ? {
          title: "Qué cambió",
          body: `Antes los precios de este proveedor venían ${taxBasis(proposal.previous)}; esta lista viene ${taxBasis(proposal.current)}. Si lo aceptás, la lista se procesa con la nueva base.`,
          approve: "Aceptar y procesar la lista",
          reject: "Descartar la lista",
        }
      : item.kind === "suspicious_instructions"
        ? {
            title: "Por qué se frenó",
            body: "El mensaje incluye instrucciones dirigidas al sistema (por ejemplo, cambiar reglas o precios en general). No se aplicó nada. Leé el mensaje original: si es una lista legítima, podés procesarla igual.",
            approve: "Procesar igual",
            reject: "Descartar",
          }
        : {
            title: "Qué pasó",
            body: `No se pudo leer automáticamente${proposal.detail ? ` (${proposal.detail})` : ""}. Si lo reintentás, la lista vuelve a la cola; si la descartás, no se hace nada.`,
            approve: "Reintentar",
            reject: "Descartar",
          };
  return (
    <>
      <Section title={copy.title}>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </Section>
      {readOnly ? null : (
        <ResolveActions
          approveLabel={copy.approve}
          rejectLabel={copy.reject}
          pending={pending}
          onApprove={() => onResolve({ action: "approve", body: {} })}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}

/** "¿De qué proveedor es?": a candidate, any existing supplier, or a new one. */
export function SupplierResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = (item.proposal ?? {}) as GateProposal;
  const suppliers = useSuppliers(!readOnly);
  const candidates = proposal.candidates ?? [];
  const [mode, setMode] = useState<string>(candidates[0]?.id ?? "other");
  const [other, setOther] = useState<string>("");
  const [newName, setNewName] = useState(proposal.supplierName ?? "");
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  return (
    <>
      <Section title="¿De qué proveedor es la lista?">
        {proposal.supplierName ? (
          <p className="text-sm text-muted-foreground">
            El documento dice:{" "}
            <span className="font-medium text-foreground">{proposal.supplierName}</span>
          </p>
        ) : null}
        <RadioGroup
          value={mode}
          onValueChange={setMode}
          disabled={readOnly}
          aria-label="Proveedor"
          className="gap-2"
        >
          {candidates.map((c) => (
            <Label
              key={c.id}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={c.id} /> <span className="font-medium">{c.name}</span>
            </Label>
          ))}
          <Label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="other" /> Otro proveedor existente
          </Label>
          <Label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="new" /> Es un proveedor nuevo
          </Label>
        </RadioGroup>
        {mode === "other" ? (
          <Select value={other} onValueChange={setOther} disabled={readOnly}>
            <SelectTrigger className="min-h-11 w-full" aria-label="Elegí el proveedor">
              <SelectValue placeholder="Elegí el proveedor" />
            </SelectTrigger>
            <SelectContent>
              {(suppliers.data?.suppliers ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {mode === "new" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Nombre del proveedor</Label>
            <Input
              id={nameId}
              value={newName}
              disabled={readOnly}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
        ) : null}
      </Section>
      {readOnly ? null : (
        <ResolveActions
          approveLabel="Asignar y procesar"
          rejectLabel="Descartar la lista"
          pending={pending}
          error={error}
          onApprove={() => {
            if (mode === "new") {
              if (!newName.trim()) return setError("Escribí el nombre del proveedor.");
              setError(null);
              return onResolve({ action: "approve", body: { createSupplier: newName.trim() } });
            }
            const supplierId = mode === "other" ? other : mode;
            if (!supplierId) return setError("Elegí un proveedor.");
            setError(null);
            onResolve({ action: "approve", body: { supplierId } });
          }}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}
