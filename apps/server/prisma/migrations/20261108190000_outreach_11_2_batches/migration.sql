-- M2 步 11-2 触达批次与草稿审批（docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md，APPROVED）
-- outreach_batch / outreach_draft / outreach_batch_approval / outreach_batch_event。Additive，无回填。

CREATE TYPE "OutreachBatchStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'DECLINED', 'EXPIRED', 'QUEUED', 'CANCELLED');
CREATE TYPE "OutreachDraftStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SKIPPED', 'SENT', 'FAILED');
CREATE TYPE "OutreachBatchApprovalState" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED');

CREATE TABLE "outreach_batch" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "status" "OutreachBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "content_hash" CHAR(64),
    "created_by" VARCHAR(256) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "queued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_batch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_batch_workspace_id_status_idx" ON "outreach_batch"("workspace_id", "status");
CREATE INDEX "outreach_batch_workspace_id_campaign_id_idx" ON "outreach_batch"("workspace_id", "campaign_id");

CREATE TABLE "outreach_draft" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "contact_ref" UUID NOT NULL,
    "recipient_email" VARCHAR(320) NOT NULL,
    "company_name" VARCHAR(200),
    "subject" VARCHAR(300) NOT NULL,
    "body" TEXT NOT NULL,
    "status" "OutreachDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "content_hash" CHAR(64),
    "approved_by" VARCHAR(256),
    "approved_at" TIMESTAMP(3),
    "rejection_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_draft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_draft_batch_id_contact_ref_key" ON "outreach_draft"("batch_id", "contact_ref");
CREATE INDEX "outreach_draft_workspace_id_batch_id_status_idx" ON "outreach_draft"("workspace_id", "batch_id", "status");

CREATE TABLE "outreach_batch_approval" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "state" "OutreachBatchApprovalState" NOT NULL DEFAULT 'PENDING',
    "requested_by" VARCHAR(256) NOT NULL,
    "decided_by" VARCHAR(256),
    "decided_at" TIMESTAMP(3),
    "decision_reason" VARCHAR(500),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_batch_approval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_batch_approval_workspace_id_state_idx" ON "outreach_batch_approval"("workspace_id", "state");
CREATE INDEX "outreach_batch_approval_batch_id_idx" ON "outreach_batch_approval"("batch_id");

CREATE TABLE "outreach_batch_event" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "actor" VARCHAR(256) NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_batch_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_batch_event_workspace_id_batch_id_created_at_idx"
    ON "outreach_batch_event"("workspace_id", "batch_id", "created_at");

ALTER TABLE "outreach_batch" ADD CONSTRAINT "outreach_batch_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_draft" ADD CONSTRAINT "outreach_draft_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_draft" ADD CONSTRAINT "outreach_draft_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "outreach_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_batch_approval" ADD CONSTRAINT "outreach_batch_approval_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_batch_approval" ADD CONSTRAINT "outreach_batch_approval_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "outreach_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_batch_event" ADD CONSTRAINT "outreach_batch_event_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_batch_event" ADD CONSTRAINT "outreach_batch_event_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "outreach_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
