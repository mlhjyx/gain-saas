-- M2.2：人工拒绝触发的自动重生成——记录来源 job，用于「再生成一次仍被拒 → NEEDS_HUMAN」判定。
ALTER TABLE "campaign_plan_job" ADD COLUMN "replan_of_job_id" UUID;
