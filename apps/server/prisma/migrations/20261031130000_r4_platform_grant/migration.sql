-- R4 平台运行 Grant 签发记录（平台准入 v2 的权威方侧）。
-- 只新增表；同一 workflow_run_id 唯一，重试拿回同一张 JWS。
CREATE TABLE "r4_platform_grant" (
  "jti" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "schedule_id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "workflow_run_id" UUID NOT NULL,
  "schedule_request_sha256" TEXT NOT NULL,
  "technical_policy_revision" TEXT NOT NULL,
  "cap_per_run_microusd" BIGINT NOT NULL,
  "campaign_cap_microusd" BIGINT NOT NULL,
  "max_runs" BIGINT NOT NULL,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "token" TEXT NOT NULL,
  "token_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "r4_platform_grant_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "r4_platform_grant_workflow_run_id_key" UNIQUE ("workflow_run_id")
);
CREATE INDEX "r4_platform_grant_schedule_id_created_at_idx"
  ON "r4_platform_grant" ("schedule_id", "created_at");
