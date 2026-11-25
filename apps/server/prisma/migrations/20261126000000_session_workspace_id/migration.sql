-- 登记租户会话所属工作空间，支持按空间精确吊销而不误踢多空间用户的其他空间会话（旧会话允许为 NULL）。
ALTER TABLE "session" ADD COLUMN "workspace_id" UUID;
CREATE INDEX "session_workspace_id_idx" ON "session"("workspace_id");
