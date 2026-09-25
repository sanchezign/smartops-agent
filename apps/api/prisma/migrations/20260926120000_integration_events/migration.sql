-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('pending', 'delivered', 'failed');

-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'integration_error';

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'pending',
    "dedupe_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "redeliveries" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_dedupe_key_key" ON "integration_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "integration_events_status_updated_at_idx" ON "integration_events"("status", "updated_at");

-- CreateIndex
CREATE INDEX "integration_events_message_id_idx" ON "integration_events"("message_id");

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

