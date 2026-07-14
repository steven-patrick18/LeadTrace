-- CreateEnum
CREATE TYPE "custom_field_type" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'DROPDOWN');

-- CreateTable
CREATE TABLE "custom_field_defs" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" "custom_field_type" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_custom_values" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "field_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_custom_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_comments" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_access_blocks" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "blocked_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_access_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_custom_values_lead_id_field_id_key" ON "lead_custom_values"("lead_id", "field_id");

-- CreateIndex
CREATE INDEX "lead_comments_lead_id_created_at_idx" ON "lead_comments"("lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_access_blocks_lead_id_user_id_key" ON "lead_access_blocks"("lead_id", "user_id");

-- AddForeignKey
ALTER TABLE "lead_custom_values" ADD CONSTRAINT "lead_custom_values_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_custom_values" ADD CONSTRAINT "lead_custom_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field_defs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_comments" ADD CONSTRAINT "lead_comments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_comments" ADD CONSTRAINT "lead_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_access_blocks" ADD CONSTRAINT "lead_access_blocks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_access_blocks" ADD CONSTRAINT "lead_access_blocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_access_blocks" ADD CONSTRAINT "lead_access_blocks_blocked_by_fkey" FOREIGN KEY ("blocked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
