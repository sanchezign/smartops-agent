-- CreateEnum
CREATE TYPE "OptOutSource" AS ENUM ('keyword', 'off_whatsapp', 'manual');

-- CreateEnum
CREATE TYPE "ConsentEventKind" AS ENUM ('opt_in', 'opt_out');

-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'possible_opt_out';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "marketing_opt_out_at" TIMESTAMPTZ(3),
ADD COLUMN     "opt_out_at" TIMESTAMPTZ(3),
ADD COLUMN     "opt_out_instruction_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "opt_out_source" "OptOutSource";

-- CreateTable
CREATE TABLE "contact_consent_events" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" "ConsentEventKind" NOT NULL,
    "method" TEXT NOT NULL,
    "keyword" TEXT,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "message_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_consent_events_contact_id_created_at_idx" ON "contact_consent_events"("contact_id", "created_at");

-- AddForeignKey
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Opt-out fields are paired (Prisma does not model CHECKs — keep this when editing Contact).
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_opt_out_chk"
  CHECK (("opt_out_at" IS NULL) = ("opt_out_source" IS NULL));
