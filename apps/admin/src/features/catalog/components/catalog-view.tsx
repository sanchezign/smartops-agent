"use client";

import { ArrowDown, ArrowUp, ChevronRight, Pencil, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthStore } from "@/features/auth/store";
import { Chip, RowLink, RowList } from "@/components/list-row";
import { useFormat } from "@/lib/use-format";
import { useCatalogSuppliers, useProducts } from "../hooks";
import type { Availability, ProductRow } from "../types";
import { RenameSupplierDialog } from "./rename-supplier-dialog";

const AVAILABILITY: Availability[] = ["all", "available", "unavailable"];

const ALL = "__all__";

export function CatalogView() {
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Availability>("all");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [renaming, setRenaming] = useState(false);
  const user = useAuthStore((s) => s.user);
  const suppliers = useCatalogSuppliers();
  const products = useProducts({ supplierId, q, availability });
  const items = products.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = suppliers.data?.suppliers.find((s) => s.id === supplierId) ?? null;
  const t = useTranslations("catalog");
  const tCommon = useTranslations("common");
  const tPages = useTranslations("pages");
  const { formatInt, formatRelative } = useFormat();

  return (
    <>
      <PageHeader title={tPages("catalog")} description={t("description")} />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Select
            value={supplierId ?? ALL}
            onValueChange={(v) => setSupplierId(v === ALL ? null : v)}
          >
            <SelectTrigger className="min-h-11 w-full" aria-label={t("supplier")}>
              <SelectValue placeholder={t("allSuppliers")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allSuppliers")}</SelectItem>
              {(suppliers.data?.suppliers ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({formatInt(s.products)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={t("search")}
            placeholder={t("search")}
            className="min-h-11 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={t("availability")}
          className="inline-flex rounded-lg border-[1.5px] p-1"
        >
          {AVAILABILITY.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={availability === a ? "secondary" : "ghost"}
              aria-pressed={availability === a}
              className="min-h-9"
              onClick={() => setAvailability(a)}
            >
              {t(`availabilityOptions.${a}`)}
            </Button>
          ))}
        </div>
        {selected ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t("availableOf", {
                available: formatInt(selected.available),
                total: formatInt(selected.products),
              })}
              {selected.lastListAt
                ? t("lastList", { when: formatRelative(selected.lastListAt) })
                : ""}
              {selected.taxIncluded === true
                ? t("taxIncluded")
                : selected.taxIncluded === false
                  ? t("taxExcluded")
                  : ""}
            </span>
            {user?.role === "admin" ? (
              <Button
                variant="outline"
                size="sm"
                className="min-h-9"
                onClick={() => setRenaming(true)}
              >
                <Pencil aria-hidden /> {t("rename")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {products.isPending ? (
        <LoadingState rows={6} />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={q ? t("noMatches") : t("empty")} />
      ) : (
        <>
          <RowList aria-label={t("listLabel")}>
            {items.map((p) => (
              <li key={p.id}>
                <ProductRowLink product={p} showSupplier={!supplierId} />
              </li>
            ))}
          </RowList>
          {products.hasNextPage ? (
            <Button
              variant="outline"
              className="mt-3 min-h-11 w-full"
              disabled={products.isFetchingNextPage}
              onClick={() => void products.fetchNextPage()}
            >
              {products.isFetchingNextPage ? tCommon("loading") : t("loadMore")}
            </Button>
          ) : null}
        </>
      )}
      {selected && renaming ? (
        <RenameSupplierDialog supplier={selected} onClose={() => setRenaming(false)} />
      ) : null}
    </>
  );
}

function ProductRowLink({ product, showSupplier }: { product: ProductRow; showSupplier: boolean }) {
  const change = product.lastChange;
  const pct = change?.changePct ? Number(change.changePct) : null;
  const t = useTranslations("catalog");
  const { formatInt, formatMoney, formatPct } = useFormat();
  return (
    <RowLink href={`/catalog/${product.id}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium">{product.name}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {showSupplier ? <span className="truncate">{product.supplier.name}</span> : null}
          {product.unit ? <Chip>{product.unit}</Chip> : null}
          {product.stock !== null ? (
            <span>{t("stock", { count: formatInt(product.stock) })}</span>
          ) : null}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-display text-lg tabular-nums">
          {formatMoney(product.price, product.currency)}
        </span>
        {!product.available ? (
          <Badge variant="outline">{t("unavailable")}</Badge>
        ) : change?.currencyChanged ? (
          <Badge variant="secondary">{t("currencyChanged")}</Badge>
        ) : pct !== null && pct !== 0 ? (
          <Badge variant={pct > 0 ? "secondary" : "outline"} className="gap-0.5 tabular-nums">
            {pct > 0 ? (
              <ArrowUp className="size-3" aria-hidden />
            ) : (
              <ArrowDown className="size-3" aria-hidden />
            )}
            {formatPct(change!.changePct!)}
          </Badge>
        ) : null}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </RowLink>
  );
}
