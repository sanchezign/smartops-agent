-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "edited_at" TIMESTAMPTZ(3),
ADD COLUMN     "revoked_at" TIMESTAMPTZ(3);

