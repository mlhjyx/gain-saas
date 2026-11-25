-- Expand: add nullable workspace_id columns first
ALTER TABLE "outreach_experiment_assignment" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "outreach_mailbox_counter" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "outreach_domain_counter" ADD COLUMN "workspace_id" UUID;

-- Backfill deterministically from parent tables
UPDATE "outreach_experiment_assignment" AS a
SET "workspace_id" = e."workspace_id"
FROM "outreach_experiment" AS e
WHERE a."experiment_id" = e."id"
  AND a."workspace_id" IS NULL;

UPDATE "outreach_mailbox_counter" AS c
SET "workspace_id" = m."workspace_id"
FROM "outreach_mailbox" AS m
WHERE c."mailbox_id" = m."id"
  AND c."workspace_id" IS NULL;

UPDATE "outreach_domain_counter" AS c
SET "workspace_id" = d."workspace_id"
FROM "outreach_domain" AS d
WHERE c."domain_id" = d."id"
  AND c."workspace_id" IS NULL;

-- Enforce NOT NULL once backfilled
ALTER TABLE "outreach_experiment_assignment" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "outreach_mailbox_counter" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "outreach_domain_counter" ALTER COLUMN "workspace_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "outreach_experiment_assignment_workspace_id_experiment_id_idx" ON "outreach_experiment_assignment"("workspace_id", "experiment_id");
CREATE INDEX "outreach_mailbox_counter_workspace_id_mailbox_id_day_idx" ON "outreach_mailbox_counter"("workspace_id", "mailbox_id", "day");
CREATE INDEX "outreach_domain_counter_workspace_id_domain_id_hour_idx" ON "outreach_domain_counter"("workspace_id", "domain_id", "hour");
