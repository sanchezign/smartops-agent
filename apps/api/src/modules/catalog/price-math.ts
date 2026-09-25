import { Prisma } from "../../generated/prisma/client.js";

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/**
 * Percentage changes applied to a current price (pure, Decimal arithmetic only).
 *
 * Rounding (user rule 2026-09-25): as many decimals as the CURRENT price has, at least 2
 * and at most 4 (Decimal(18,4)), half-up. If rounding at that precision would distort
 * the change by more than PCT_TOLERANCE percentage points (tiny unit prices), more
 * decimals are used, up to 4:
 *   12.5   +7.5 % → 13.4375 → 13.44   (2 decimals; effective +7.52 %)
 *   0.035  +10 %  → 0.0385            (3 decimals would give 0.039 = +11.43 %)
 */

export const MIN_PRICE_DECIMALS = 2;
export const MAX_PRICE_DECIMALS = 4;
/** Max distance (percentage points) between the stated and the effective change. */
export const PCT_TOLERANCE = new Decimal("0.1");

/** Significant decimal places of a price ("12.5000" → 1, "0.035" → 3). */
export function priceDecimals(price: Decimal): number {
  return price.decimalPlaces();
}

export function applyPercentage(current: Decimal, pct: Decimal | string): Decimal {
  const percentage = new Decimal(pct);
  if (current.lte(0)) throw new Error("current price must be greater than 0");
  const exact = current.times(new Decimal(1).plus(percentage.dividedBy(100)));
  const start = Math.min(MAX_PRICE_DECIMALS, Math.max(MIN_PRICE_DECIMALS, priceDecimals(current)));
  for (let dp = start; dp <= MAX_PRICE_DECIMALS; dp += 1) {
    const rounded = exact.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
    const effective = rounded.minus(current).dividedBy(current).times(100);
    if (dp === MAX_PRICE_DECIMALS || effective.minus(percentage).abs().lte(PCT_TOLERANCE)) {
      return rounded;
    }
  }
  /* c8 ignore next */
  return exact.toDecimalPlaces(MAX_PRICE_DECIMALS, Decimal.ROUND_HALF_UP);
}
