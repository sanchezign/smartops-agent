-- Panel deep link for WhatsApp digests (phase 9 M7): /d/<link_token>, random, unique.
ALTER TABLE "notification_digests" ADD COLUMN "link_token" TEXT;
CREATE UNIQUE INDEX "notification_digests_link_token_key" ON "notification_digests"("link_token");
