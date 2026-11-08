-- ch05 P4-06：入站邮件 ingest 的并发幂等（external_id = 入站 Message-ID）。
-- 1) 先清历史重复：external_id 非空时按 (workspace_id, external_id) 保留最早一条
--    （created_at 最早，同刻按 id 字典序）；被删除行只可能是同一封邮件的重复 ingest。
-- 2) 再建部分唯一索引（external_id 为空的旧行不参与，NULL 允许重复）。
-- 注意：Prisma schema 无法表达部分索引，此约束由本迁移管理，勿在 schema.prisma 加 @@unique。

DELETE FROM "outreach_reply" r
USING "outreach_reply" keep
WHERE r."external_id" IS NOT NULL
  AND keep."external_id" = r."external_id"
  AND keep."workspace_id" = r."workspace_id"
  AND (
    keep."created_at" < r."created_at"
    OR (keep."created_at" = r."created_at" AND keep."id" < r."id")
  );

CREATE UNIQUE INDEX "outreach_reply_workspace_external_id_key"
    ON "outreach_reply"("workspace_id", "external_id")
    WHERE "external_id" IS NOT NULL;
