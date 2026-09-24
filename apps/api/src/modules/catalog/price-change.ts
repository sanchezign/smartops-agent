import { Prisma } from "../../generated/prisma/client.js";

type Money = { price: Prisma.Decimal; currency: string };

export interface PriceChangeValues {
  oldPrice: Prisma.Decimal | null;
  oldCurrency: string | null;
  newPrice: Prisma.Decimal;
  newCurrency: string;
  /** null when there is no previous price, the previous price is 0, or the currency changed. */
  changePct: Prisma.Decimal | null;
  currencyChanged: boolean;
}

/**
 * Computes the PriceChange row for a product price update.
 * Mirrors the CHECK constraints of migration `price_change_rules`:
 * - currencyChanged ⇔ there was a previous currency and it differs;
 * - currency changed → changePct = null (no cross-currency percentages);
 * - no previous price → changePct = null.
 * changePct = (new - old) / old * 100, rounded half-up to 4 decimals.
 */
export function computePriceChange(previous: Money | null, next: Money): PriceChangeValues {
  const newCurrency = next.currency.toUpperCase();
  const oldCurrency = previous ? previous.currency.toUpperCase() : null;
  const currencyChanged = oldCurrency !== null && oldCurrency !== newCurrency;

  let changePct: Prisma.Decimal | null = null;
  if (previous && !currencyChanged && !previous.price.isZero()) {
    changePct = next.price
      .minus(previous.price)
      .dividedBy(previous.price)
      .times(100)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  return {
    oldPrice: previous?.price ?? null,
    oldCurrency,
    newPrice: next.price,
    newCurrency,
    changePct,
    currencyChanged,
  };
}
