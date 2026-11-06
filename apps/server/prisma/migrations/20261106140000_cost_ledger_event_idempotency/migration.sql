-- 1b 花费维度补口（2026-11-06）：cost_ledger 按 (workspace_id, source_event_id) 幂等，
-- 事件消费 at-least-once 重放不重复计费。Postgres 唯一索引对 NULL 默认 NULLS DISTINCT，
-- 存量/未来 source_event_id 为空的行不受约束（等价 partial unique 的效果）。
-- 当前表为空，建索引无回填冲突。
CREATE UNIQUE INDEX "cost_ledger_workspace_id_source_event_id_key" ON "cost_ledger" ("workspace_id", "source_event_id");
