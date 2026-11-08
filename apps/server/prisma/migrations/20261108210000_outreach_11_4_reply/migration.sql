-- M2 步 11-4 回复/退订/退信回写（docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md，APPROVED）
-- outreach_reply；退订 token 记录收件邮箱（用于平台级抑制）；批次/发送状态增加 COMPLETED/SKIPPED。

ALTER TYPE "OutreachBatchStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "OutreachSendStatus" ADD VALUE 'SKIPPED';

ALTER TABLE "outreach_unsubscribe_token" ADD COLUMN "recipient_email" VARCHAR(320);

CREATE TYPE "OutreachReplyKind" AS ENUM ('REPLY', 'BOUNCE', 'UNSUBSCRIBE');
CREATE TYPE "OutreachReplyClassification" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'OUT_OF_OFFICE', 'UNKNOWN');

CREATE TABLE "outreach_reply" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_ref" UUID NOT NULL,
    "recipient_email" VARCHAR(320),
    "kind" "OutreachReplyKind" NOT NULL DEFAULT 'REPLY',
    "classification" "OutreachReplyClassification" NOT NULL DEFAULT 'UNKNOWN',
    "subject" VARCHAR(300),
    "snippet" VARCHAR(500),
    "external_id" VARCHAR(256),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_reply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_reply_workspace_id_contact_ref_received_at_idx"
    ON "outreach_reply"("workspace_id", "contact_ref", "received_at");
CREATE INDEX "outreach_reply_workspace_id_kind_received_at_idx"
    ON "outreach_reply"("workspace_id", "kind", "received_at");

ALTER TABLE "outreach_reply" ADD CONSTRAINT "outreach_reply_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
