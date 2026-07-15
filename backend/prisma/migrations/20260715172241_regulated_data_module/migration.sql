-- CreateTable
CREATE TABLE "lead_background_reports" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "purpose" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "run_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_background_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_background_reports_lead_id_idx" ON "lead_background_reports"("lead_id");

-- AddForeignKey
ALTER TABLE "lead_background_reports" ADD CONSTRAINT "lead_background_reports_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_background_reports" ADD CONSTRAINT "lead_background_reports_run_by_fkey" FOREIGN KEY ("run_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
