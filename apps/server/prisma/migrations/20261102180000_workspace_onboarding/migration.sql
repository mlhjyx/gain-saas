-- SD11 注册引导：新注册空间从 NULL 开始（前端强制进入引导向导）；
-- 存量空间回填为迁移时刻，不打断既有用户。
ALTER TABLE "workspace"
  ADD COLUMN "onboarding_completed_at" TIMESTAMP(3),
  ADD COLUMN "onboarding_company_id" UUID;

UPDATE "workspace" SET "onboarding_completed_at" = now();
