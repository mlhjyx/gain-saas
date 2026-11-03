-- Run 2.0（M0②）：任务对象前移。
-- acquisition_task：挖掘需求（绑定引擎侧 ICP，只存引用）；task_run：每次执行，
-- engine_run_id 关联引擎 discovery_run（引擎侧以 task_ref 记录同一对 id）。
CREATE TABLE "acquisition_task" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_task_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acquisition_task_status_check" CHECK ("status" IN ('active', 'paused', 'archived')),
    CONSTRAINT "acquisition_task_name_check" CHECK (char_length("name") BETWEEN 1 AND 200)
);

CREATE INDEX "acquisition_task_workspace_id_icp_id_idx"
    ON "acquisition_task"("workspace_id", "icp_id");

ALTER TABLE "acquisition_task"
    ADD CONSTRAINT "acquisition_task_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_run" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "engine_run_id" UUID,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "requested_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "budget_ref" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_run_trigger_check" CHECK ("trigger" IN ('manual', 'schedule')),
    CONSTRAINT "task_run_status_check" CHECK ("status" IN ('RUNNING', 'DONE', 'PARTIAL', 'FAILED', 'CANCELLED'))
);

CREATE UNIQUE INDEX "task_run_engine_run_id_key" ON "task_run"("engine_run_id");

CREATE INDEX "task_run_workspace_id_task_id_created_at_idx"
    ON "task_run"("workspace_id", "task_id", "created_at");

ALTER TABLE "task_run"
    ADD CONSTRAINT "task_run_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_run"
    ADD CONSTRAINT "task_run_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "acquisition_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
