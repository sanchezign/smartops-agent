"use client";

import { useTranslations } from "next-intl";
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
import { useFormat } from "@/lib/use-format";
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

/** "Everything goes up 8%": the preview per product; approving applies it where the price did not change since. */
export function GlobalChangeResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = item.proposal as GlobalChangeProposal;
  const t = useTranslations("reviews.global");
  const { formatMoney, formatPct } = useFormat();
  const outliers = proposal.products.filter((p) => p.outlier).length;
  return (
    <>
      <Section
        title={t("announced", { pct: formatPct(proposal.pct), count: proposal.products.length })}
      >
        {outliers ? (
          <p className="text-sm text-muted-foreground">{t("outliers", { count: outliers })}</p>
        ) : null}
        <div className="overflow-x-auto rounded-lg border-[1.5px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("product")}</TableHead>
                <TableHead className="text-right">{t("before")}</TableHead>
                <TableHead className="text-right">{t("after")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposal.products.map((p) => (
                <TableRow key={p.productId}>
                  <TableCell className="max-w-48 truncate">
                    {p.name}
                    {p.outlier ? (
                      <Badge variant="destructive" className="ml-2">
                        {t("outlierBadge")}
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
          approveLabel={t("apply", { pct: formatPct(proposal.pct) })}
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
  const t = useTranslations("reviews.unavailable");
  const { formatMoney } = useFormat();
  return (
    <>
      <Section title={t("product")}>
        <p className="text-sm">
          <span className="font-medium">{item.product?.name ?? t("product")}</span>
          {item.product ? (
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {t("currentPrice", { price: formatMoney(item.product.price, item.product.currency) })}
            </span>
          ) : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {proposal.reason === "missing_from_full_list"
            ? t("missingFromFull")
            : t("statedUnavailable")}{" "}
          {t("consequence")}
        </p>
      </Section>
      {readOnly ? null : (
        <ResolveActions
          approveLabel={t("approve")}
          rejectLabel={t("reject")}
          pending={pending}
          onApprove={() => onResolve({ action: "approve", body: {} })}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}

const taxBasisKey = (v: boolean | null | undefined) =>
  v === true ? "taxIncluded" : v === false ? "taxExcluded" : "taxUnknown";

/** Whole-list gates: tax basis change, suspicious instructions, extraction failed. */
export function GateResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = (item.proposal ?? {}) as GateProposal;
  const t = useTranslations("reviews.gate");
  const copy =
    item.kind === "tax_basis_changed"
      ? {
          title: t("taxTitle"),
          body: t("taxBody", {
            previous: t(taxBasisKey(proposal.previous)),
            current: t(taxBasisKey(proposal.current)),
          }),
          approve: t("taxApprove"),
          reject: t("discardList"),
        }
      : item.kind === "suspicious_instructions"
        ? {
            title: t("suspiciousTitle"),
            body: t("suspiciousBody"),
            approve: t("suspiciousApprove"),
            reject: t("discard"),
          }
        : {
            title: t("failedTitle"),
            body: proposal.detail
              ? t("failedBodyDetail", { detail: proposal.detail })
              : t("failedBody"),
            approve: t("retry"),
            reject: t("discard"),
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

/** "Which supplier is it from?": a candidate, any existing supplier, or a new one. */
export function SupplierResolver({ item, readOnly, pending, onResolve }: ResolverProps) {
  const proposal = (item.proposal ?? {}) as GateProposal;
  const suppliers = useSuppliers(!readOnly);
  const candidates = proposal.candidates ?? [];
  const [mode, setMode] = useState<string>(candidates[0]?.id ?? "other");
  const [other, setOther] = useState<string>("");
  const [newName, setNewName] = useState(proposal.supplierName ?? "");
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const t = useTranslations("reviews.supplier");
  const tGate = useTranslations("reviews.gate");

  return (
    <>
      <Section title={t("title")}>
        {proposal.supplierName ? (
          <p className="text-sm text-muted-foreground">
            {t("documentSays")}{" "}
            <span className="font-medium text-foreground">{proposal.supplierName}</span>
          </p>
        ) : null}
        <RadioGroup
          value={mode}
          onValueChange={setMode}
          disabled={readOnly}
          aria-label={t("label")}
          className="gap-2"
        >
          {candidates.map((c) => (
            <Label
              key={c.id}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={c.id} /> <span className="font-medium">{c.name}</span>
            </Label>
          ))}
          <Label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="other" /> {t("otherExisting")}
          </Label>
          <Label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="new" /> {t("isNew")}
          </Label>
        </RadioGroup>
        {mode === "other" ? (
          <Select value={other} onValueChange={setOther} disabled={readOnly}>
            <SelectTrigger className="min-h-11 w-full" aria-label={t("choose")}>
              <SelectValue placeholder={t("choose")} />
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
            <Label htmlFor={nameId}>{t("newName")}</Label>
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
          approveLabel={t("approve")}
          rejectLabel={tGate("discardList")}
          pending={pending}
          error={error}
          onApprove={() => {
            if (mode === "new") {
              if (!newName.trim()) return setError(t("nameRequired"));
              setError(null);
              return onResolve({ action: "approve", body: { createSupplier: newName.trim() } });
            }
            const supplierId = mode === "other" ? other : mode;
            if (!supplierId) return setError(t("pickOne"));
            setError(null);
            onResolve({ action: "approve", body: { supplierId } });
          }}
          onReject={(note) => onResolve({ action: "reject", note })}
        />
      )}
    </>
  );
}
