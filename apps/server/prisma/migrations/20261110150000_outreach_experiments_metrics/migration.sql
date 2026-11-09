-- ch05 P4-09：实验（holdout/AB）与指标快照。Additive，无回填。

CREATE TABLE "outreach_experiment" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "primary_metric" VARCHAR(64) NOT NULL,
    "design" VARCHAR(16) NOT NULL DEFAULT 'holdout',
    "holdout_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "strata" JSONB,
    "assignment_salt" CHAR(64) NOT NULL,
    "analysis_plan" JSONB,
    "state" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_experiment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outreach_experiment_workspace_id_state_idx"
    ON "outreach_experiment"("workspace_id", "state");

CREATE TABLE "outreach_experiment_assignment" (
    "id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "subject_type" VARCHAR(16) NOT NULL DEFAULT 'account',
    "subject_ref" UUID NOT NULL,
    "arm" VARCHAR(8) NOT NULL,
    "bucket" INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_experiment_assignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreach_experiment_assignment_experiment_id_subject_type_subject_ref_key"
    ON "outreach_experiment_assignment"("experiment_id", "subject_type", "subject_ref");
CREATE INDEX "outreach_experiment_assignment_experiment_id_arm_idx"
    ON "outreach_experiment_assignment"("experiment_id", "arm");
ALTER TABLE "outreach_experiment_assignment" ADD CONSTRAINT "outreach_experiment_assignment_experiment_id_fkey"
    FOREIGN KEY ("experiment_id") REFERENCES "outreach_experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "outreach_metric_snapshot" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "experiment_id" UUID,
    "channel" VARCHAR(16) NOT NULL,
    "arm" VARCHAR(8),
    "metric" VARCHAR(64) NOT NULL,
    "numerator" INTEGER NOT NULL,
    "denominator" INTEGER NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "definition_version" VARCHAR(16) NOT NULL,
    "labor_hours" DOUBLE PRECISION,
    "cost_micros" INTEGER,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_metric_snapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outreach_metric_snapshot_workspace_id_channel_window_end_idx"
    ON "outreach_metric_snapshot"("workspace_id", "channel", "window_end");
