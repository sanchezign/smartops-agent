"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { InputError } from "@/lib/number-input";
import { useFormat } from "@/lib/use-format";
import { useInputErrorText } from "@/lib/use-input-error";
import type { ResolveInput } from "../hooks";
import { lineApproveBody, lineDefaults, type LineChoice } from "../resolve-input";
import type { LineProposal, ReviewItem } from "../types";
import { ResolveActions } from "./resolve-actions";
import { Section } from "./section";

/**
 * Line review: which product is it (candidates or a new one) and at what price. The values
 * start as the system's proposal; the person can correct them before approving.
 */
export function LineResolver({
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
  const proposal = item.proposal as LineProposal;
  const locale = useLocale();
  const t = useTranslations("reviews.line");
  const { formatMoney, formatPct } = useFormat();
  const errorText = useInputErrorText();
  const defaults = useMemo(
    () => lineDefaults(proposal, item.product?.id ?? null, item.product?.currency ?? null, locale),
    [proposal, item.product, locale],
  );
  const [choice, setChoice] = useState<LineChoice>(defaults);
  const [error, setError] = useState<InputError | null>(null);
  const ids = { price: useId(), currency: useId(), name: useId(), unit: useId() };
  const line = proposal.item;

  const candidates = proposal.candidates.length
    ? proposal.candidates
    : item.product
      ? [
          {
            id: item.product.id,
            name: item.product.name,
            price: item.product.price,
            currency: item.product.currency,
          },
        ]
      : [];

  return (
    <>
      <Section title={t("listSays")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("product")}</dt>
          <dd className="font-medium">{line.name}</dd>
          {line.unit ? (
            <>
              <dt className="text-muted-foreground">{t("unit")}</dt>
              <dd>{line.unit}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("price")}</dt>
          <dd>
            {line.price
              ? formatMoney(line.price, line.currency ?? proposal.listCurrency ?? "")
              : line.priceChangePct
                ? formatPct(line.priceChangePct)
                : "—"}
          </dd>
          {proposal.changePct ? (
            <>
              <dt className="text-muted-foreground">{t("change")}</dt>
              <dd>
                <Badge
                  variant={Math.abs(Number(proposal.changePct)) >= 30 ? "destructive" : "secondary"}
                >
                  {formatPct(proposal.changePct)}
                </Badge>
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title={t("whichProduct")}>
        <RadioGroup
          value={choice.target}
          onValueChange={(target) => setChoice((c) => ({ ...c, target }))}
          disabled={readOnly}
          aria-label={t("product")}
          className="gap-2"
        >
          {candidates.map((c) => (
            <Label
              key={c.id}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3 py-2 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50"
            >
              <RadioGroupItem value={c.id} />
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{c.name ?? t("product")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {c.price && c.currency
                    ? t("currentPrice", { price: formatMoney(c.price, c.currency) })
                    : t("noPrice")}
                </span>
              </span>
            </Label>
          ))}
          <Label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3 py-2 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50">
            <RadioGroupItem value="new" />
            <span className="font-medium">{t("isNew")}</span>
          </Label>
        </RadioGroup>
      </Section>

      <Section title={t("priceToApply")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {choice.target === "new" ? (
            <>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor={ids.name}>{t("name")}</Label>
                <Input
                  id={ids.name}
                  value={choice.name}
                  disabled={readOnly}
                  onChange={(e) => setChoice((c) => ({ ...c, name: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.unit}>{t("unit")}</Label>
                <Input
                  id={ids.unit}
                  value={choice.unit}
                  disabled={readOnly}
                  onChange={(e) => setChoice((c) => ({ ...c, unit: e.target.value }))}
                />
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.price}>{t("price")}</Label>
            <Input
              id={ids.price}
              inputMode="decimal"
              value={choice.price}
              disabled={readOnly}
              placeholder={
                line.priceChangePct
                  ? t("pctPlaceholder", { pct: formatPct(line.priceChangePct) })
                  : ""
              }
              onChange={(e) => setChoice((c) => ({ ...c, price: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.currency}>{t("currency")}</Label>
            <Input
              id={ids.currency}
              value={choice.currency}
              maxLength={3}
              autoCapitalize="characters"
              disabled={readOnly}
              onChange={(e) => setChoice((c) => ({ ...c, currency: e.target.value }))}
            />
          </div>
        </div>
      </Section>

      {readOnly ? null : (
        <ResolveActions
          approveLabel={choice.target === "new" ? t("createProduct") : t("applyPrice")}
          pending={pending}
          error={error ? errorText(error) : null}
          onApprove={() => {
            const result = lineApproveBody(choice, defaults, locale);
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
