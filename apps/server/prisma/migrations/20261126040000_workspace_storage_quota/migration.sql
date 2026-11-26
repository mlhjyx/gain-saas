BEGIN;

CREATE TABLE "public"."workspace_storage_quota" (
    "workspace_id" UUID NOT NULL,
    "max_documents_per_workspace" INTEGER NOT NULL DEFAULT 500,
    "max_documents_per_company" INTEGER NOT NULL DEFAULT 200,
    "max_bytes_per_workspace" BIGINT NOT NULL DEFAULT 2147483648,
    "max_exports_per_day" INTEGER NOT NULL DEFAULT 10,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_storage_quota_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "public"."workspace_storage_quota"
  ADD CONSTRAINT "workspace_storage_quota_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."workspace_storage_quota" TO gain_saas_app;

ALTER TABLE "public"."workspace_storage_quota" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workspace_storage_quota" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_storage_quota_tenant_isolation" ON "public"."workspace_storage_quota";
CREATE POLICY "workspace_storage_quota_tenant_isolation"
  ON "public"."workspace_storage_quota"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

COMMIT;
