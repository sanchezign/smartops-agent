-- CreateEnum
CREATE TYPE "MessagePurpose" AS ENUM ('auto_reply', 'compliance', 'team_notification', 'human');

-- CreateEnum
CREATE TYPE "ConversationModeReason" AS ENUM ('human_reply_panel', 'human_reply_app', 'manual_pause', 'manual_resume', 'timeout');

-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'canceled';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "mode_changed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "claimed_at" TIMESTAMPTZ(3),
ADD COLUMN     "purpose" "MessagePurpose";

-- CreateTable
CREATE TABLE "conversation_mode_changes" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "from_mode" "ConversationMode" NOT NULL,
    "to_mode" "ConversationMode" NOT NULL,
    "human_until" TIMESTAMPTZ(3),
    "reason" "ConversationModeReason" NOT NULL,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_mode_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_mode_changes_conversation_id_created_at_idx" ON "conversation_mode_changes"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_mode_changes" ADD CONSTRAINT "conversation_mode_changes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_mode_changes" ADD CONSTRAINT "conversation_mode_changes_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_mode_changes" ADD CONSTRAINT "conversation_mode_changes_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill (phase 7): every existing OUTBOUND message gets a purpose.
UPDATE "messages" SET "purpose" = 'team_notification'
 WHERE "direction" = 'outbound' AND "idempotency_key" LIKE 'digest:%';
UPDATE "messages" SET "purpose" = 'human'
 WHERE "direction" = 'outbound' AND "purpose" IS NULL AND "author" = 'human';
UPDATE "messages" SET "purpose" = 'auto_reply'
 WHERE "direction" = 'outbound' AND "purpose" IS NULL;

-- Outbound ⇔ purpose (Prisma does not model CHECKs — keep this when editing Message).
ALTER TABLE "messages" ADD CONSTRAINT "messages_purpose_chk"
  CHECK (("direction" = 'outbound') = ("purpose" IS NOT NULL));
