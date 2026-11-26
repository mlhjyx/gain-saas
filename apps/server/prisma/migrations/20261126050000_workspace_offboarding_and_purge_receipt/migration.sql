BEGIN;

CREATE TABLE "public"."workspace_offboarding_request" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'SCHEDULED',
    "requested_by" UUID NOT NULL,
    "reason" VARCHAR(500),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cool_off_ends_at" TIMESTAMP(3) NOT NULL,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "purged_by" UUID,
    "purged_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_offboarding_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_offboarding_request_workspace_id_status_idx"
  ON "public"."workspace_offboarding_request"("workspace_id", "status");
CREATE INDEX "workspace_offboarding_request_status_cool_off_ends_at_idx"
  ON "public"."workspace_offboarding_request"("status", "cool_off_ends_at");
CREATE UNIQUE INDEX "workspace_offboarding_request_active_workspace_key"
  ON "public"."workspace_offboarding_request"("workspace_id")
  WHERE ("status" = 'SCHEDULED');

ALTER TABLE "public"."workspace_offboarding_request"
  ADD CONSTRAINT "workspace_offboarding_request_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."workspace_offboarding_request" TO gain_saas_app;

ALTER TABLE "public"."workspace_offboarding_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workspace_offboarding_request" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_offboarding_request_tenant_isolation" ON "public"."workspace_offboarding_request";
CREATE POLICY "workspace_offboarding_request_tenant_isolation"
  ON "public"."workspace_offboarding_request"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

CREATE TABLE "public"."workspace_purge_receipt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'IN_PROGRESS',
    "requested_by" UUID NOT NULL,
    "offboarding_request_id" UUID,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "revoked_sessions" INTEGER NOT NULL DEFAULT 0,
    "deleted_counts" JSONB NOT NULL,
    "campaign_plan_job_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "engine_purge_receipt_id" UUID,
    "engine_purge_status" VARCHAR(32),
    "error_code" VARCHAR(64),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_purge_receipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_purge_receipt_workspace_id_idempotency_key_key"
  ON "public"."workspace_purge_receipt"("workspace_id", "idempotency_key");
CREATE INDEX "workspace_purge_receipt_workspace_id_started_at_idx"
  ON "public"."workspace_purge_receipt"("workspace_id", "started_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."workspace_purge_receipt" TO gain_saas_app;

ALTER TABLE "public"."workspace_purge_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workspace_purge_receipt" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_purge_receipt_tenant_isolation" ON "public"."workspace_purge_receipt";
CREATE POLICY "workspace_purge_receipt_tenant_isolation"
  ON "public"."workspace_purge_receipt"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

COMMIT;
