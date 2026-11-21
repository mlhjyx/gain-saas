-- 退信回写待发队列（缺口 3 P2）：SMTP 硬拒与 DSN 退信先落队，worker 批量调引擎
-- /contact-points/{pointId}/bounce-events（messageId 为引擎侧幂等键）。
CREATE TABLE "outreach_bounce_writeback" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_point_id" UUID NOT NULL,
    "event" VARCHAR(32) NOT NULL,
    "message_id" VARCHAR(256) NOT NULL,
    "smtp_code" VARCHAR(64),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_bounce_writeback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_bounce_writeback_contact_point_id_message_id_key"
    ON "outreach_bounce_writeback"("contact_point_id", "message_id");
CREATE INDEX "outreach_bounce_writeback_status_created_at_idx"
    ON "outreach_bounce_writeback"("status", "created_at");
