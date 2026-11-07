-- M2.0 Campaign 控制面最小域（docs/technical/campaign-control-plane-m2-0.md · ADR-0001）：
-- campaign / campaign_revision / campaign_audience / campaign_approval /
-- campaign_execution_authorization / campaign_decision_trace 六表 + 四枚举。
-- 全部 additive，无回填、无既有表变更。

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CampaignRevisionState" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'DECLINED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CampaignApprovalState" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CampaignAuthorizationState" AS ENUM ('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "campaign" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "current_revision_id" UUID,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_revision" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "plan" JSONB NOT NULL,
    "plan_hash" TEXT NOT NULL,
    "state" "CampaignRevisionState" NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_audience" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "icp_ids" JSONB NOT NULL,
    "include_filters" JSONB,
    "exclude_filters" JSONB,
    "size_cap" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_audience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_approval" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "plan_hash" TEXT NOT NULL,
    "state" "CampaignApprovalState" NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_execution_authorization" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "plan_hash" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "token" TEXT NOT NULL,
    "state" "CampaignAuthorizationState" NOT NULL DEFAULT 'ISSUED',
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_execution_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_decision_trace" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID,
    "revision_id" UUID,
    "trace_id" TEXT NOT NULL,
    "parent_trace_id" TEXT,
    "step_type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "workflow" TEXT,
    "workflow_version" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "decision_type" TEXT NOT NULL,
    "gate" TEXT,
    "policy_version" TEXT,
    "chosen_option" TEXT,
    "score" DOUBLE PRECISION,
    "reason_code" TEXT,
    "evidence" JSONB,
    "rejected_candidates" JSONB,
    "cost_estimated_micros" BIGINT,
    "cost_actual_micros" BIGINT,
    "budget_domain" TEXT,
    "budget_remaining_micros" BIGINT,
    "approval_state" TEXT,
    "approval_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_decision_trace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_workspace_id_status_idx" ON "campaign"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "campaign_revision_workspace_id_plan_hash_idx" ON "campaign_revision"("workspace_id", "plan_hash");

-- CreateIndex
CREATE INDEX "campaign_revision_workspace_id_state_idx" ON "campaign_revision"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_revision_campaign_id_revision_no_key" ON "campaign_revision"("campaign_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_audience_revision_id_key" ON "campaign_audience"("revision_id");

-- CreateIndex
CREATE INDEX "campaign_audience_workspace_id_idx" ON "campaign_audience"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_approval_workspace_id_state_idx" ON "campaign_approval"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "campaign_approval_revision_id_idx" ON "campaign_approval"("revision_id");

-- CreateIndex
CREATE INDEX "campaign_execution_authorization_workspace_id_state_idx" ON "campaign_execution_authorization"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "campaign_execution_authorization_campaign_id_idx" ON "campaign_execution_authorization"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_decision_trace_workspace_id_campaign_id_idx" ON "campaign_decision_trace"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "campaign_decision_trace_trace_id_idx" ON "campaign_decision_trace"("trace_id");

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_revision" ADD CONSTRAINT "campaign_revision_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience" ADD CONSTRAINT "campaign_audience_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "campaign_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_approval" ADD CONSTRAINT "campaign_approval_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "campaign_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

