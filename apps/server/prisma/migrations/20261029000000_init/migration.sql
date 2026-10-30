-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "jti" TEXT NOT NULL,
    "realm" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_registry" (
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cursor" TEXT,
    "last_pulled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_registry_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "event_inbox" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "acked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualified_lead" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_id" TEXT NOT NULL,
    "icp_id" TEXT,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qualified_lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "user_id" UUID,
    "type" TEXT NOT NULL,
    "ref_id" TEXT,
    "title" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "realm" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_submission" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "iso_week" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "accepted" INTEGER NOT NULL,
    "rejected" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_mirror" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "engine_request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "saas_deleted" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_ledger" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_event_id" TEXT,
    "amount_micros" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signing_key" (
    "kid" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_key_pkey" PRIMARY KEY ("kid")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "membership_user_id_workspace_id_key" ON "membership"("user_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_key" ON "invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ops_user_email_key" ON "ops_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_jti_key" ON "session"("jti");

-- CreateIndex
CREATE INDEX "session_subject_id_idx" ON "session"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_inbox_event_id_key" ON "event_inbox"("event_id");

-- CreateIndex
CREATE INDEX "event_inbox_workspace_id_occurred_at_idx" ON "event_inbox"("workspace_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "qualified_lead_event_id_key" ON "qualified_lead"("event_id");

-- CreateIndex
CREATE INDEX "qualified_lead_workspace_id_idx" ON "qualified_lead"("workspace_id");

-- CreateIndex
CREATE INDEX "notification_workspace_id_read_at_idx" ON "notification"("workspace_id", "read_at");

-- CreateIndex
CREATE INDEX "audit_log_realm_actor_id_idx" ON "audit_log"("realm", "actor_id");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_mirror_engine_request_id_key" ON "deletion_mirror"("engine_request_id");

-- CreateIndex
CREATE INDEX "cost_ledger_workspace_id_idx" ON "cost_ledger"("workspace_id");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_registry" ADD CONSTRAINT "workspace_registry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

