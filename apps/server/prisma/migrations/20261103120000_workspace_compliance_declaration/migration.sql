-- D6 per-tenant 合法依据声明（数据处理声明）：
-- 每 workspace 每次（重新）声明新增一版，历史保留用于审计；
-- BFF 在联系人发现/猜测/验证三路由自动注入当前版本（产品负责人 2026-11-03 拍板）。
CREATE TABLE "workspace_compliance_declaration" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "ref" TEXT,
    "note" TEXT,
    "declared_by" UUID NOT NULL,
    "declared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_compliance_declaration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_compliance_declaration_workspace_id_version_key"
    ON "workspace_compliance_declaration"("workspace_id", "version");

ALTER TABLE "workspace_compliance_declaration"
    ADD CONSTRAINT "workspace_compliance_declaration_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
