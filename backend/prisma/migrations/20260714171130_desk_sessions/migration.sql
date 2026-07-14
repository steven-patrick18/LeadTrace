-- CreateEnum
CREATE TYPE "desk_session_end" AS ENUM ('CLOCK_OUT', 'TAKEOVER', 'FORCED');

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "desk_session_id" INTEGER;

-- CreateTable
CREATE TABLE "desks" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desk_sessions" (
    "id" SERIAL NOT NULL,
    "desk_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" "desk_session_end",
    "ended_by" INTEGER,

    CONSTRAINT "desk_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "desks_code_key" ON "desks"("code");

-- CreateIndex
CREATE INDEX "desk_sessions_desk_id_ended_at_idx" ON "desk_sessions"("desk_id", "ended_at");

-- CreateIndex
CREATE INDEX "desk_sessions_user_id_ended_at_idx" ON "desk_sessions"("user_id", "ended_at");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_desk_session_id_fkey" FOREIGN KEY ("desk_session_id") REFERENCES "desk_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_sessions" ADD CONSTRAINT "desk_sessions_desk_id_fkey" FOREIGN KEY ("desk_id") REFERENCES "desks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_sessions" ADD CONSTRAINT "desk_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_sessions" ADD CONSTRAINT "desk_sessions_ended_by_fkey" FOREIGN KEY ("ended_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
