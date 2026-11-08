-- M2 步 11-3 发送台账与审计包（docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md，APPROVED）
-- outreach_send / outreach_audit_package；批次状态增加 SENT。Additive，无回填。

ALTER TYPE "OutreachBatchStatus" ADD VALUE 'SENT';

CREATE TYPE "OutreachSendStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "outreach_send" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "recipient_email" VARCHAR(320) NOT NULL,
    "subject_hash" CHAR(64) NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "mailbox_address" VARCHAR(320) NOT NULL,
    "message_id" VARCHAR(256),
    "status" "OutreachSendStatus" NOT NULL DEFAULT 'SENT',
    "error" VARCHAR(1000),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_send_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_send_batch_id_draft_id_attempt_key"
    ON "outreach_send"("batch_id", "draft_id", "attempt");
CREATE INDEX "outreach_send_workspace_id_batch_id_status_idx"
    ON "outreach_send"("workspace_id", "batch_id", "status");

CREATE TABLE "outreach_audit_package" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "package" JSONB NOT NULL,
    "package_hash" CHAR(64) NOT NULL,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_audit_package_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_audit_package_batch_id_package_hash_key"
    ON "outreach_audit_package"("batch_id", "package_hash");
CREATE INDEX "outreach_audit_package_workspace_id_batch_id_idx"
    ON "outreach_audit_package"("workspace_id", "batch_id");

ALTER TABLE "outreach_send" ADD CONSTRAINT "outreach_send_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_send" ADD CONSTRAINT "outreach_send_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "outreach_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_audit_package" ADD CONSTRAINT "outreach_audit_package_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_audit_package" ADD CONSTRAINT "outreach_audit_package_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "outreach_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
