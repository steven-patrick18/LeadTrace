-- CreateEnum
CREATE TYPE "permission_scope" AS ENUM ('ALL', 'OWN', 'ASSIGNED', 'VIEW');

-- CreateEnum
CREATE TYPE "lead_tier" AS ENUM ('AGENT', 'SR_AGENT', 'CLOSER');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('NEW', 'PENDING_ROUTING', 'IN_PROGRESS', 'QUALIFIED', 'CLOSED_WON', 'CLOSED_LOST', 'INVALID');

-- CreateEnum
CREATE TYPE "transfer_point" AS ENUM ('T1_TO_SS', 'T2_TO_CLOSER', 'T3_SEND_BACK');

-- CreateEnum
CREATE TYPE "queue_status" AS ENUM ('PENDING', 'ROUTED');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('CALL', 'NOTE', 'STATUS_CHANGE', 'TRANSFER_REQUEST');

-- CreateEnum
CREATE TYPE "system_status" AS ENUM ('ACTIVE', 'LOCKED');

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "role_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "tier" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "permission_key" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "scope" "permission_scope" NOT NULL DEFAULT 'ALL',

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role_id" INTEGER NOT NULL,
    "reports_to" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "created_by" INTEGER NOT NULL,
    "assigned_to" INTEGER,
    "current_tier" "lead_tier" NOT NULL DEFAULT 'AGENT',
    "status" "lead_status" NOT NULL DEFAULT 'NEW',
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "primary_phone" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "source_provider" TEXT,
    "raw_provider_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_phones" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "line_type" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lead_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_queue" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "transfer_point" "transfer_point" NOT NULL,
    "raised_by" INTEGER NOT NULL,
    "status" "queue_status" NOT NULL DEFAULT 'PENDING',
    "routed_by" INTEGER,
    "routed_to" INTEGER,
    "aging_alert_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routed_at" TIMESTAMP(3),

    CONSTRAINT "routing_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_history" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "transfer_point" "transfer_point" NOT NULL,
    "from_user" INTEGER,
    "to_user" INTEGER NOT NULL,
    "routed_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" "activity_type" NOT NULL,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_cache" (
    "id" SERIAL NOT NULL,
    "search_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_settings" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "cost_per_search_cents" INTEGER NOT NULL DEFAULT 0,
    "daily_spend_cap_cents" INTEGER NOT NULL DEFAULT 0,
    "cache_ttl_hours" INTEGER NOT NULL DEFAULT 720,
    "permitted_use_attestation" TEXT,
    "attested_by" INTEGER,
    "attested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_usage" (
    "id" SERIAL NOT NULL,
    "provider_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "search_key" TEXT NOT NULL,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "lead_id" INTEGER,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" "system_status" NOT NULL DEFAULT 'ACTIVE',
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_key" (
    "id" SERIAL NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "recovery_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_code_key" ON "roles"("role_code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_role_id_permission_key_key" ON "permissions"("role_id", "permission_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "leads_assigned_to_status_idx" ON "leads"("assigned_to", "status");

-- CreateIndex
CREATE INDEX "leads_current_tier_status_idx" ON "leads"("current_tier", "status");

-- CreateIndex
CREATE INDEX "leads_primary_phone_idx" ON "leads"("primary_phone");

-- CreateIndex
CREATE INDEX "lead_phones_phone_idx" ON "lead_phones"("phone");

-- CreateIndex
CREATE INDEX "routing_queue_status_transfer_point_idx" ON "routing_queue"("status", "transfer_point");

-- CreateIndex
CREATE INDEX "routing_history_lead_id_idx" ON "routing_history"("lead_id");

-- CreateIndex
CREATE INDEX "routing_history_created_at_idx" ON "routing_history"("created_at");

-- CreateIndex
CREATE INDEX "activities_lead_id_created_at_idx" ON "activities"("lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_cache_search_key_key" ON "search_cache"("search_key");

-- CreateIndex
CREATE INDEX "search_cache_expires_at_idx" ON "search_cache"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_settings_code_key" ON "provider_settings"("code");

-- CreateIndex
CREATE INDEX "provider_usage_provider_id_created_at_idx" ON "provider_usage"("provider_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_user_id_created_at_idx" ON "audit_log"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_reports_to_fkey" FOREIGN KEY ("reports_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_phones" ADD CONSTRAINT "lead_phones_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_queue" ADD CONSTRAINT "routing_queue_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_queue" ADD CONSTRAINT "routing_queue_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_queue" ADD CONSTRAINT "routing_queue_routed_by_fkey" FOREIGN KEY ("routed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_queue" ADD CONSTRAINT "routing_queue_routed_to_fkey" FOREIGN KEY ("routed_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_history" ADD CONSTRAINT "routing_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
