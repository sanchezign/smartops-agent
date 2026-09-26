-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_login_at" TIMESTAMPTZ(3),
ADD COLUMN     "lock_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "login_window_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3);

