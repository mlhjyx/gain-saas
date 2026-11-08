-- M2.2：有界重规划的人工兜底状态 + 逐轮历史。
ALTER TYPE "CampaignPlanJobState" ADD VALUE IF NOT EXISTS 'NEEDS_HUMAN';
ALTER TABLE "campaign_plan_job" ADD COLUMN "replan_history" JSONB;
