-- M2 步 11-1 合规底座（docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md，APPROVED）
-- outreach_consent（append-only 同意台账）+ outreach_unsubscribe_token（一次性退订 token，只存 SHA-256）。
-- Additive，无回填。

CREATE TYPE "OutreachConsentStatus" AS ENUM ('OPT_IN', 'OPT_OUT', 'UNKNOWN');

CREATE TABLE "outreach_consent" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_ref" UUID NOT NULL,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'email',
    "status" "OutreachConsentStatus" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "lawful_basis" VARCHAR(64) NOT NULL,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_consent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_consent_workspace_contact_created_idx"
    ON "outreach_consent"("workspace_id", "contact_ref", "channel", "created_at");

CREATE TABLE "outreach_unsubscribe_token" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_ref" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_unsubscribe_token_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outreach_unsubscribe_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "outreach_unsubscribe_token_token_hash_key"
    ON "outreach_unsubscribe_token"("token_hash");
CREATE INDEX "outreach_unsubscribe_token_workspace_contact_idx"
    ON "outreach_unsubscribe_token"("workspace_id", "contact_ref");

ALTER TABLE "outreach_consent" ADD CONSTRAINT "outreach_consent_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_unsubscribe_token" ADD CONSTRAINT "outreach_unsubscribe_token_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
