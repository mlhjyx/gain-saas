-- ch05 P4-02/P4-04：发信资产、配额计数、种子记录与发送遥测。Additive，无回填。

-- 1) 发送遥测（SMTP 协议层结果；HARD=5xx 永久拒绝，SOFT=4xx/超时/网络）
ALTER TABLE "outreach_send"
    ADD COLUMN "smtp_status_code" INTEGER,
    ADD COLUMN "smtp_response" VARCHAR(500),
    ADD COLUMN "bounce_type" VARCHAR(8),
    ADD COLUMN "latency_ms" INTEGER;

-- 2) 发信域资产
CREATE TABLE "outreach_domain" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'cold_outbound',
    "state" VARCHAR(16) NOT NULL DEFAULT 'WARMING',
    "health_state" VARCHAR(16) NOT NULL DEFAULT 'CLOSED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_domain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreach_domain_workspace_id_domain_key"
    ON "outreach_domain"("workspace_id", "domain");

-- 3) 发件信箱资产
CREATE TABLE "outreach_mailbox" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'smtp',
    "daily_cap" INTEGER NOT NULL DEFAULT 10,
    "weekly_cap" INTEGER NOT NULL DEFAULT 50,
    "warmup_stage" VARCHAR(16) NOT NULL DEFAULT 'W1',
    "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin',
    "health_state" VARCHAR(16) NOT NULL DEFAULT 'CLOSED',
    "last_send_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_mailbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreach_mailbox_workspace_id_address_key"
    ON "outreach_mailbox"("workspace_id", "address");
ALTER TABLE "outreach_mailbox" ADD CONSTRAINT "outreach_mailbox_domain_id_fkey"
    FOREIGN KEY ("domain_id") REFERENCES "outreach_domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) 信箱日配额计数（发送成功后原子递增）
CREATE TABLE "outreach_mailbox_counter" (
    "mailbox_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "hard_bounces" INTEGER NOT NULL DEFAULT 0,
    "complaints" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "outreach_mailbox_counter_pkey" PRIMARY KEY ("mailbox_id", "day")
);
ALTER TABLE "outreach_mailbox_counter" ADD CONSTRAINT "outreach_mailbox_counter_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "outreach_mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) 发件域 × 收件域小时计数（同域限速落库版）
CREATE TABLE "outreach_domain_counter" (
    "domain_id" UUID NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "recipient_domain" VARCHAR(253) NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "outreach_domain_counter_pkey" PRIMARY KEY ("domain_id", "hour", "recipient_domain")
);
ALTER TABLE "outreach_domain_counter" ADD CONSTRAINT "outreach_domain_counter_domain_id_fkey"
    FOREIGN KEY ("domain_id") REFERENCES "outreach_domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) 种子放置测试记录（warmup/seed 周检查清单的后端支撑）
CREATE TABLE "outreach_seed_test" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "tested_at" TIMESTAMP(3) NOT NULL,
    "inbox_pct" DOUBLE PRECISION,
    "spam_pct" DOUBLE PRECISION,
    "missing_pct" DOUBLE PRECISION,
    "gmail_inbox_pct" DOUBLE PRECISION,
    "outlook_inbox_pct" DOUBLE PRECISION,
    "report_ref" VARCHAR(256) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_seed_test_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outreach_seed_test_domain_id_tested_at_idx"
    ON "outreach_seed_test"("domain_id", "tested_at");
CREATE INDEX "outreach_seed_test_workspace_id_tested_at_idx"
    ON "outreach_seed_test"("workspace_id", "tested_at");
ALTER TABLE "outreach_seed_test" ADD CONSTRAINT "outreach_seed_test_domain_id_fkey"
    FOREIGN KEY ("domain_id") REFERENCES "outreach_domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
