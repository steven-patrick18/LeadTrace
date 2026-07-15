-- AlterEnum
ALTER TYPE "transfer_point" ADD VALUE 'T1_DIRECT';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "office_id" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "office_id" INTEGER;

-- CreateTable
CREATE TABLE "offices" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offices_name_key" ON "offices"("name");

-- CreateIndex
CREATE INDEX "leads_office_id_idx" ON "leads"("office_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One-time data fix: the T2->T3 bucket belongs to Managers (common bucket for
-- all managers). Grant route_leads to the MANAGER role; the Admin keeps full
-- control and can revoke it any time on the Permissions page.
UPDATE "permissions" SET "allowed" = true, "scope" = 'ALL'
WHERE "permission_key" = 'route_leads'
  AND "role_id" IN (SELECT "id" FROM "roles" WHERE "role_code" = 'MANAGER');
