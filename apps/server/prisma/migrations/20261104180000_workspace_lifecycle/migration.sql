-- workspace 生命周期（2026-11-04）：停用/归档。
-- ACTIVE 正常；DISABLED 停用（租户请求 403、事件轮询停止、Grant 停发，可恢复）；
-- ARCHIVED 归档（同停用，仅运营可还原）。存量空间全部回填 ACTIVE。
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

ALTER TABLE "workspace"
    ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "status_updated_at" TIMESTAMP(3),
    ADD COLUMN "status_updated_by" TEXT,
    ADD COLUMN "status_note" TEXT;
