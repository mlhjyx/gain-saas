-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN "workspace_id" UUID;

-- CreateIndex
CREATE INDEX "audit_log_realm_workspace_id_at_idx" ON "audit_log"("realm", "workspace_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_workspace_id_at_idx" ON "audit_log"("workspace_id", "at");

-- Safe UUID-validated backfill:
-- 1) From detail->>'workspaceId' (e.g. outreach.t0.touch, bff.request, campaign.created)
UPDATE "audit_log"
SET "workspace_id" = ("detail"->>'workspaceId')::uuid
WHERE "workspace_id" IS NULL
  AND "detail" IS NOT NULL
  AND jsonb_typeof("detail") = 'object'
  AND ("detail"->>'workspaceId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 2) Known tenant actions whose target column stores workspace_id
UPDATE "audit_log"
SET "workspace_id" = "target"::uuid
WHERE "workspace_id" IS NULL
  AND "realm" = 'tenant'
  AND "action" IN (
    'auth.register',
    'auth.login',
    'auth.switch_workspace',
    'members.accept_invite',
    'workspaces.rename',
    'workspaces.leave',
    'onboarding.preview_started',
    'onboarding.complete'
  )
  AND "target" IS NOT NULL
  AND "target" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3) Known ops workspace-scoped actions (workspace.status, export.leads)
UPDATE "audit_log"
SET "workspace_id" = CASE
  WHEN ("detail"->'after'->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN ("detail"->'after'->>'id')::uuid
  WHEN ("detail"->'before'->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN ("detail"->'before'->>'id')::uuid
  ELSE NULL
END
WHERE "workspace_id" IS NULL
  AND "realm" = 'ops'
  AND "action" = 'workspace.status'
  AND "detail" IS NOT NULL
  AND jsonb_typeof("detail") = 'object';

UPDATE "audit_log"
SET "workspace_id" = "target"::uuid
WHERE "workspace_id" IS NULL
  AND "realm" = 'ops'
  AND "action" = 'export.leads'
  AND "target" IS NOT NULL
  AND "target" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
