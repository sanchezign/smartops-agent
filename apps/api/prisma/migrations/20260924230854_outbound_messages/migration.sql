-- CreateEnum
CREATE TYPE "OptInSource" AS ENUM ('inbound', 'manual');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "opt_in_at" TIMESTAMPTZ(3),
ADD COLUMN     "opt_in_source" "OptInSource";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "messages_idempotency_key_key" ON "messages"("idempotency_key");

-- ADR-009: contacts that already wrote to us have an implicit opt-in (source inbound),
-- dated at their first inbound message.
UPDATE "contacts" c
   SET "opt_in_at" = first_inbound.at,
       "opt_in_source" = 'inbound'
  FROM (
    SELECT v."contact_id", MIN(COALESCE(m."wa_timestamp", m."created_at")) AS at
      FROM "messages" m
      JOIN "conversations" v ON v."id" = m."conversation_id"
     WHERE m."direction" = 'inbound'
     GROUP BY v."contact_id"
  ) AS first_inbound
 WHERE c."id" = first_inbound."contact_id"
   AND c."opt_in_at" IS NULL;

-- Opt-in fields go together.
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_opt_in_chk" CHECK (("opt_in_at" IS NULL) = ("opt_in_source" IS NULL));
