-- Phase 13 (i18n): the panel language chosen by each user. NULL = follow the browser.
ALTER TABLE "users" ADD COLUMN "locale" TEXT;

-- Hand-written (Prisma does not model CHECK constraints): only the panel's languages.
ALTER TABLE "users" ADD CONSTRAINT "users_locale_chk" CHECK ("locale" IS NULL OR "locale" IN ('en', 'es'));
