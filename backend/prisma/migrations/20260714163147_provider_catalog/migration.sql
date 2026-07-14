-- AlterTable
ALTER TABLE "provider_settings" ADD COLUMN     "api_key" TEXT,
ADD COLUMN     "api_secret" TEXT,
ADD COLUMN     "base_url" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "docs_url" TEXT,
ADD COLUMN     "how_to_get" TEXT,
ADD COLUMN     "signup_url" TEXT,
ADD COLUMN     "website_url" TEXT;
