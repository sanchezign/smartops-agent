-- AlterEnum
ALTER TYPE "WebhookEventStatus" ADD VALUE 'ignored';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "bsuid" TEXT,
ADD COLUMN     "username" TEXT,
ALTER COLUMN "wa_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "webhook_event_id" UUID;

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "enqueued_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "message_status_events" (
    "id" UUID NOT NULL,
    "wa_message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3),
    "recipient_wa_id" TEXT,
    "recipient_user_id" TEXT,
    "errors" JSONB,
    "pricing" JSONB,
    "message_id" UUID,
    "webhook_event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_status_events_message_id_idx" ON "message_status_events"("message_id");

-- CreateIndex
CREATE INDEX "message_status_events_webhook_event_id_idx" ON "message_status_events"("webhook_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_status_events_wa_message_id_status_key" ON "message_status_events"("wa_message_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_bsuid_key" ON "contacts"("bsuid");

-- CreateIndex
CREATE INDEX "messages_webhook_event_id_idx" ON "messages"("webhook_event_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Contact identity (Prisma does not model CHECK constraints; keep this when editing
-- the Contact model): Meta may send only a phone (wa_id), only a business-scoped
-- user id (bsuid), or both — but never neither.
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_identity_chk" CHECK ("wa_id" IS NOT NULL OR "bsuid" IS NOT NULL);
