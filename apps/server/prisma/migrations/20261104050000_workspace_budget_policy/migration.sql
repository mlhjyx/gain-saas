-- Phase 1b：workspace 累计预算/配额（拒绝钱包攻击）。
-- 签发一次性 Grant 前按滚动窗口检查 run 次数与花费；存量 workspace 全部豁免，
-- 仅新注册 workspace 懒创建 policy 行并按默认值（30 次 / 15 USD / 30 天）执行。
-- 产品负责人 2026-11-04 拍板：新注册 30 次/$15，现有 workspace 全部豁免。
CREATE TABLE "workspace_budget_policy" (
    "workspace_id" UUID NOT NULL,
    "window_days" INTEGER NOT NULL DEFAULT 30,
    "max_runs" INTEGER NOT NULL,
    "max_spend_micros" BIGINT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_budget_policy_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "workspace_budget_policy"
    ADD CONSTRAINT "workspace_budget_policy_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 存量 workspace 全部豁免（enabled=false）；新 workspace 无行，懒创建时按默认值启用。
INSERT INTO "workspace_budget_policy"
    ("workspace_id", "window_days", "max_runs", "max_spend_micros", "enabled", "updated_by", "updated_at")
SELECT "id", 30, 30, 15000000, false, 'migration:20261104-seed-exempt', CURRENT_TIMESTAMP
FROM "workspace";
