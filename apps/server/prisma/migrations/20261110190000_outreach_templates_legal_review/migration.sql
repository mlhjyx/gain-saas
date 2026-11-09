-- ch05 P4-05：法审记录与模板版本化（新模板默认 DRAFT，不生效；激活需 APPROVED 法审）。Additive。

CREATE TABLE "legal_review" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subject_kind" VARCHAR(32) NOT NULL,
    "document_hash" CHAR(64) NOT NULL,
    "reviewer_name" VARCHAR(200) NOT NULL,
    "reviewer_firm" VARCHAR(200) NOT NULL,
    "reviewed_at" DATE NOT NULL,
    "scope" VARCHAR(500) NOT NULL,
    "verdict" VARCHAR(16) NOT NULL,
    "conditions" TEXT,
    "document_ref" VARCHAR(256) NOT NULL,
    "created_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_review_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "legal_review_workspace_id_subject_kind_idx"
    ON "legal_review"("workspace_id", "subject_kind");

CREATE TABLE "outreach_template_version" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "jurisdiction" VARCHAR(3) NOT NULL DEFAULT 'ALL',
    "language" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" VARCHAR(300),
    "body" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "legal_review_id" UUID,
    "state" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "created_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outreach_template_version_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreach_template_version_workspace_id_kind_jurisdiction_language_version_key"
    ON "outreach_template_version"("workspace_id", "kind", "jurisdiction", "language", "version");
CREATE INDEX "outreach_template_version_workspace_id_kind_state_idx"
    ON "outreach_template_version"("workspace_id", "kind", "state");
