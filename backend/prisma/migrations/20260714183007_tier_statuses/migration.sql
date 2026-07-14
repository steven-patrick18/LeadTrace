-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "work_status_id" INTEGER;

-- CreateTable
CREATE TABLE "tier_statuses" (
    "id" SERIAL NOT NULL,
    "tier" "lead_tier" NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tier_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tier_statuses_tier_label_key" ON "tier_statuses"("tier", "label");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_work_status_id_fkey" FOREIGN KEY ("work_status_id") REFERENCES "tier_statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
