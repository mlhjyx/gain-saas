-- ch05 P4-10：DE 电话推定同意证据链（basis + attempt）。Additive，无回填。
-- 同时为 legal_review 增加 reviewer_kind（用户 2026-11-09 决定允许负责人内部风险接受自签；审计如实记录）。

ALTER TABLE "legal_review"
    ADD COLUMN "reviewer_kind" VARCHAR(24) NOT NULL DEFAULT 'LAWYER';

CREATE TABLE "outreach_call_basis" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_ref" UUID NOT NULL,
    "phone_e164" VARCHAR(32) NOT NULL,
    "company_name" VARCHAR(200) NOT NULL,
    "contact_role" VARCHAR(200),
    "trigger_type" VARCHAR(32) NOT NULL,
    "trigger_evidence" JSONB NOT NULL,
    "relevance_statement" TEXT NOT NULL,
    "lawful_basis" VARCHAR(64) NOT NULL DEFAULT 'uwg_7_2_1_presumed_consent+gdpr_6_1_f',
    "collected_source_url" VARCHAR(2048) NOT NULL,
    "collected_at" DATE NOT NULL,
    "script_template_id" UUID NOT NULL,
    "legal_review_id" UUID NOT NULL,
    "reviewed_by" VARCHAR(200) NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "valid_until" DATE NOT NULL,
    "created_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_call_basis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outreach_call_basis_workspace_id_contact_ref_valid_until_idx"
    ON "outreach_call_basis"("workspace_id", "contact_ref", "valid_until");

CREATE TABLE "outreach_call_attempt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "basis_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "outcome" VARCHAR(24) NOT NULL,
    "objection_code" VARCHAR(32),
    "notes_hash" CHAR(64),
    "notes_ref" VARCHAR(256),
    "created_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_call_attempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreach_call_attempt_basis_id_attempt_no_key"
    ON "outreach_call_attempt"("basis_id", "attempt_no");
CREATE INDEX "outreach_call_attempt_workspace_id_started_at_idx"
    ON "outreach_call_attempt"("workspace_id", "started_at");
ALTER TABLE "outreach_call_attempt" ADD CONSTRAINT "outreach_call_attempt_basis_id_fkey"
    FOREIGN KEY ("basis_id") REFERENCES "outreach_call_basis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
