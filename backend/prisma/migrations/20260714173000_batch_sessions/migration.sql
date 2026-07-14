-- Per-user batch IDs + short-lived quick sessions

ALTER TABLE "users" ADD COLUMN "batch_id" TEXT;
CREATE UNIQUE INDEX "users_batch_id_key" ON "users"("batch_id");

CREATE TYPE "batch_session_end" AS ENUM ('EXPIRED', 'ENDED', 'REVOKED');

CREATE TABLE "batch_sessions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "initiated_by" INTEGER NOT NULL,
    "sid" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" "batch_session_end",

    CONSTRAINT "batch_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "batch_sessions_sid_key" ON "batch_sessions"("sid");
CREATE INDEX "batch_sessions_user_id_ended_at_idx" ON "batch_sessions"("user_id", "ended_at");

ALTER TABLE "batch_sessions" ADD CONSTRAINT "batch_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_sessions" ADD CONSTRAINT "batch_sessions_initiated_by_fkey"
  FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
