-- P1 attempt 维度（2026-11-04）：TaskRun 记录 planId / 任务内第 N 次尝试 / 幂等键 / 重试来源。
-- expand-only：只加可空列与索引；存量行按任务内创建时间回填 attempt=1..N。

ALTER TABLE "task_run" ADD COLUMN "plan_id" UUID;
ALTER TABLE "task_run" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "task_run" ADD COLUMN "attempt_key" UUID;
ALTER TABLE "task_run" ADD COLUMN "rerun_of" UUID;

-- 存量回填：同一任务内按 created_at, id 稳定排序编号。
UPDATE "task_run" AS tr
SET "attempt" = numbered.rn
FROM (
  SELECT "id",
         row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at", "id") AS rn
  FROM "task_run"
) AS numbered
WHERE tr."id" = numbered."id";

CREATE UNIQUE INDEX "task_run_task_id_attempt_key" ON "task_run" ("task_id", "attempt");
CREATE UNIQUE INDEX "task_run_task_id_attempt_key_key" ON "task_run" ("task_id", "attempt_key");

ALTER TABLE "task_run"
  ADD CONSTRAINT "task_run_rerun_of_fkey"
  FOREIGN KEY ("rerun_of") REFERENCES "task_run" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
