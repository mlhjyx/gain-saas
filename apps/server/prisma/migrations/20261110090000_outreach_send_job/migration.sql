-- ch05 P4-04：发送 job 队列（审批通过入队，worker 原子认领执行）。Additive，无回填。

CREATE TYPE "OutreachSendJobState" AS ENUM ('PENDING', 'CLAIMED', 'DONE', 'FAILED', 'CANCELLED');

CREATE TABLE "outreach_send_job" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "state" "OutreachSendJobState" NOT NULL DEFAULT 'PENDING',
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claim_token" UUID,
    "claimed_at" TIMESTAMP(3),
    "last_error" VARCHAR(1000),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outreach_send_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_send_job_idempotency_key_key"
    ON "outreach_send_job"("idempotency_key");
CREATE INDEX "outreach_send_job_state_next_attempt_at_idx"
    ON "outreach_send_job"("state", "next_attempt_at");
CREATE INDEX "outreach_send_job_workspace_id_batch_id_idx"
    ON "outreach_send_job"("workspace_id", "batch_id");
