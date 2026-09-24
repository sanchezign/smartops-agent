-- AlterTable
ALTER TABLE "price_changes" ALTER COLUMN "change_pct" SET DATA TYPE DECIMAL;

-- Price change rules (Prisma does not model CHECK constraints; keep these when
-- editing the PriceChange model):
-- 1. currency_changed is true exactly when there was a previous currency and it differs.
-- 2. When the currency changed, change_pct must be NULL (percentages across currencies are meaningless).
-- 3. Without a previous price there is no percentage.
ALTER TABLE "price_changes"
  ADD CONSTRAINT "price_changes_currency_changed_chk"
    CHECK ("currency_changed" = ("old_currency" IS NOT NULL AND "old_currency" <> "new_currency")),
  ADD CONSTRAINT "price_changes_pct_null_on_currency_change_chk"
    CHECK (NOT "currency_changed" OR "change_pct" IS NULL),
  ADD CONSTRAINT "price_changes_pct_requires_old_price_chk"
    CHECK ("old_price" IS NOT NULL OR "change_pct" IS NULL);
