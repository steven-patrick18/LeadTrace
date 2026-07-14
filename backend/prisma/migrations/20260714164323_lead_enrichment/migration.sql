-- CreateEnum
CREATE TYPE "enrichment_status" AS ENUM ('PENDING', 'PARTIAL', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "lead_enrichment" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "provider_data" JSONB,
    "geo_data" JSONB,
    "compliance_data" JSONB,
    "intelligence" JSONB,
    "enriched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enriched_by" INTEGER NOT NULL,
    "enrichment_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "enrichment_status" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "lead_enrichment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_weights" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "score_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dnc_optout" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "added_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dnc_optout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_enrichment_lead_id_key" ON "lead_enrichment"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "score_weights_key_key" ON "score_weights"("key");

-- CreateIndex
CREATE UNIQUE INDEX "dnc_optout_phone_key" ON "dnc_optout"("phone");

-- AddForeignKey
ALTER TABLE "lead_enrichment" ADD CONSTRAINT "lead_enrichment_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_enrichment" ADD CONSTRAINT "lead_enrichment_enriched_by_fkey" FOREIGN KEY ("enriched_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dnc_optout" ADD CONSTRAINT "dnc_optout_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
