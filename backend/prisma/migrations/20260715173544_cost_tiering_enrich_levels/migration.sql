-- AlterTable
ALTER TABLE "provider_settings" ADD COLUMN     "enrich_level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "run_on_search" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "enrich_level" INTEGER NOT NULL DEFAULT 1;
