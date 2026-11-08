-- M2 步 10：QGO / SAO / Opportunity Outcome（Growth Core，additive）。
-- 候选与线索仍是引擎对象（不拆 lead 表，D-10-e）；本迁移只建商机域三表。
-- 说明：本仓既有表一律「workspace_id 外键 + 应用层按 workspace 过滤 + 跨租户 404」，
-- 未启用数据库级 RLS（设计稿中「FORCE RLS 按既有模式」按实际既有模式落地为前者）。
CREATE TABLE "qgo" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_ref" UUID NOT NULL,
    "canonical_company_ref" UUID NOT NULL,
    "icp_ref" UUID,
    "campaign_id" UUID,
    "title" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "evidence" JSONB NOT NULL,
    "next_step" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qgo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qgo_state_check" CHECK ("state" IN ('OPEN', 'CONVERTED', 'DROPPED')),
    CONSTRAINT "qgo_next_step_check" CHECK (char_length("next_step") BETWEEN 1 AND 500),
    CONSTRAINT "qgo_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "qgo_evidence_array_check" CHECK (jsonb_typeof("evidence") = 'array' AND jsonb_array_length("evidence") >= 1)
);

CREATE UNIQUE INDEX "qgo_workspace_id_lead_ref_key" ON "qgo"("workspace_id", "lead_ref");
CREATE INDEX "qgo_workspace_id_state_idx" ON "qgo"("workspace_id", "state");

ALTER TABLE "qgo"
    ADD CONSTRAINT "qgo_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sao" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "qgo_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sao_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sao_state_check" CHECK ("state" IN ('ACCEPTED', 'DECLINED')),
    CONSTRAINT "sao_reason_check" CHECK ("reason" IS NULL OR char_length("reason") <= 1000)
);

CREATE UNIQUE INDEX "sao_workspace_id_qgo_id_key" ON "sao"("workspace_id", "qgo_id");
-- 一 QGO 一 SAO（Prisma 1:1 定义侧单列唯一；qgo id 本身全局唯一）。
CREATE UNIQUE INDEX "sao_qgo_id_key" ON "sao"("qgo_id");
CREATE INDEX "sao_workspace_id_state_idx" ON "sao"("workspace_id", "state");

ALTER TABLE "sao"
    ADD CONSTRAINT "sao_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sao"
    ADD CONSTRAINT "sao_qgo_id_fkey"
    FOREIGN KEY ("qgo_id") REFERENCES "qgo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "opportunity_outcome" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sao_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "evidence_ref" TEXT,
    "note" TEXT,
    "source_event_id" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_outcome_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "opportunity_outcome_outcome_check" CHECK ("outcome" IN (
        'REPLIED', 'MEETING_BOOKED', 'QUOTE_SENT', 'WON', 'LOST', 'NO_RESPONSE', 'DISQUALIFIED'
    )),
    CONSTRAINT "opportunity_outcome_source_check" CHECK ("source" IN ('SYSTEM', 'MANUAL')),
    CONSTRAINT "opportunity_outcome_note_check" CHECK ("note" IS NULL OR char_length("note") <= 2000)
);

-- 系统回写幂等（NULL 允许多行：人工登记不设幂等键）。
CREATE UNIQUE INDEX "opportunity_outcome_sao_id_source_event_id_key"
    ON "opportunity_outcome"("sao_id", "source_event_id");
CREATE INDEX "opportunity_outcome_workspace_id_occurred_at_idx"
    ON "opportunity_outcome"("workspace_id", "occurred_at");

ALTER TABLE "opportunity_outcome"
    ADD CONSTRAINT "opportunity_outcome_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "opportunity_outcome"
    ADD CONSTRAINT "opportunity_outcome_sao_id_fkey"
    FOREIGN KEY ("sao_id") REFERENCES "sao"("id") ON DELETE CASCADE ON UPDATE CASCADE;
