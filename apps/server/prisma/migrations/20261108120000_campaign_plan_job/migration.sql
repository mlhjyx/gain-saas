-- M2.1 受限 Campaign Planner：campaign_plan_job（异步规划 job）+ 活跃 job 部分唯一索引。
-- 全部 additive，无回填、无既有表变更。
-- 租户隔离沿用本仓既有模式（workspace_id 必填 + 应用层过滤 + 跨租户 404；本仓无 RLS，
-- 见 docs/technical/campaign-control-plane-m2-0.md §8）。

-- CreateEnum
CREATE TYPE "CampaignPlanJobState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "campaign_plan_job" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "state" "CampaignPlanJobState" NOT NULL DEFAULT 'PENDING',
    "objective" TEXT NOT NULL,
    "icp_id" UUID,
    "engine_run_ref" TEXT,
    "plan_hash" TEXT,
    "revision_id" UUID,
    "error" TEXT,
    "issues" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_plan_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_plan_job_workspace_id_campaign_id_idx" ON "campaign_plan_job"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "campaign_plan_job_workspace_id_state_idx" ON "campaign_plan_job"("workspace_id", "state");

-- CreateIndex（同一 campaign 同时只允许一个 PENDING/RUNNING job；重复触发 → 409）
CREATE UNIQUE INDEX "campaign_plan_job_active_per_campaign" ON "campaign_plan_job"("campaign_id") WHERE "state" IN ('PENDING', 'RUNNING');

-- AddForeignKey
ALTER TABLE "campaign_plan_job" ADD CONSTRAINT "campaign_plan_job_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
