-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('run_summary', 'customer_query', 'integration_error', 'manual_attention');

-- CreateEnum
CREATE TYPE "NotificationDigestStatus" AS ENUM ('open', 'sent', 'panel_only', 'failed');

-- CreateTable
CREATE TABLE "notification_items" (
    "id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'info',
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "digest_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_digests" (
    "id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "NotificationDigestStatus" NOT NULL DEFAULT 'open',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "window_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "text" TEXT,
    "channel" TEXT,
    "outbound_message_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_items_recipient_created_at_idx" ON "notification_items"("recipient", "created_at");

-- CreateIndex
CREATE INDEX "notification_items_digest_id_idx" ON "notification_items"("digest_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_items_recipient_dedupe_key_key" ON "notification_items"("recipient", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_digests_recipient_status_idx" ON "notification_digests"("recipient", "status");

-- CreateIndex
CREATE INDEX "notification_digests_recipient_sent_at_idx" ON "notification_digests"("recipient", "sent_at");

-- AddForeignKey
ALTER TABLE "notification_items" ADD CONSTRAINT "notification_items_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "notification_digests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

