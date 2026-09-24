-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('supplier', 'customer', 'internal', 'unknown');

-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('bot', 'human');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts', 'interactive', 'button', 'reaction', 'template', 'unsupported');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('contact', 'bot', 'human');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('received', 'pending', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "IngestionClassification" AS ENUM ('price_list_full', 'price_update_partial', 'customer_query', 'internal_order', 'other');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('pending', 'classified', 'extracted', 'ingested', 'needs_review', 'failed');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('price_change', 'low_stock', 'missing_data', 'ingestion_error');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('open', 'sent', 'acknowledged', 'dismissed');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'operator');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'system', 'n8n');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "name" TEXT,
    "kind" "ContactKind" NOT NULL DEFAULT 'unknown',
    "supplier_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "mode" "ConversationMode" NOT NULL DEFAULT 'bot',
    "human_until" TIMESTAMPTZ(3),
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "wa_message_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL,
    "author" "MessageAuthor" NOT NULL,
    "author_user_id" UUID,
    "text" TEXT,
    "transcript" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'received',
    "status_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "wa_timestamp" TIMESTAMPTZ(3),
    "media_file_id" UUID,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" UUID NOT NULL,
    "wa_media_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "filename" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT,
    "price" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_changes" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "old_price" DECIMAL(18,4),
    "old_currency" CHAR(3),
    "new_price" DECIMAL(18,4) NOT NULL,
    "new_currency" CHAR(3) NOT NULL,
    "change_pct" DECIMAL(9,4),
    "currency_changed" BOOLEAN NOT NULL DEFAULT false,
    "ingestion_run_id" UUID,
    "source_message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "supplier_id" UUID,
    "classification" "IngestionClassification",
    "status" "IngestionStatus" NOT NULL DEFAULT 'pending',
    "raw_extraction" JSONB,
    "report" JSONB,
    "errors" JSONB,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'info',
    "status" "AlertStatus" NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "payload" JSONB,
    "product_id" UUID,
    "ingestion_run_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'operator',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "data" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_wa_id_key" ON "contacts"("wa_id");

-- CreateIndex
CREATE INDEX "contacts_supplier_id_idx" ON "contacts"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_contact_id_key" ON "conversations"("contact_id");

-- CreateIndex
CREATE INDEX "conversations_mode_human_until_idx" ON "conversations"("mode", "human_until");

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_wa_message_id_key" ON "messages"("wa_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_media_file_id_key" ON "messages"("media_file_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_author_user_id_idx" ON "messages"("author_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_wa_media_id_key" ON "media_files"("wa_media_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_supplier_id_normalized_name_key" ON "products"("supplier_id", "normalized_name");

-- CreateIndex
CREATE INDEX "price_changes_product_id_created_at_idx" ON "price_changes"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "price_changes_ingestion_run_id_idx" ON "price_changes"("ingestion_run_id");

-- CreateIndex
CREATE INDEX "price_changes_source_message_id_idx" ON "price_changes"("source_message_id");

-- CreateIndex
CREATE INDEX "ingestion_runs_status_created_at_idx" ON "ingestion_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_message_id_idx" ON "ingestion_runs"("message_id");

-- CreateIndex
CREATE INDEX "ingestion_runs_supplier_id_idx" ON "ingestion_runs"("supplier_id");

-- CreateIndex
CREATE INDEX "alerts_status_created_at_idx" ON "alerts"("status", "created_at");

-- CreateIndex
CREATE INDEX "alerts_product_id_idx" ON "alerts"("product_id");

-- CreateIndex
CREATE INDEX "alerts_ingestion_run_id_idx" ON "alerts"("ingestion_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
