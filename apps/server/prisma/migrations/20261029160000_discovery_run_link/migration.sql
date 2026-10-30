-- 引擎没有按 plan/ICP 列出 run 的端点；SaaS 保存已发起任务的引用，
-- 让用户关闭页面或换设备后仍能回到寻源任务。
CREATE TABLE "discovery_run_link" (
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_run_link_pkey" PRIMARY KEY ("run_id")
);

CREATE INDEX "discovery_run_link_workspace_id_plan_id_idx"
    ON "discovery_run_link"("workspace_id", "plan_id");

CREATE INDEX "discovery_run_link_workspace_id_icp_id_idx"
    ON "discovery_run_link"("workspace_id", "icp_id");

ALTER TABLE "discovery_run_link"
    ADD CONSTRAINT "discovery_run_link_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
