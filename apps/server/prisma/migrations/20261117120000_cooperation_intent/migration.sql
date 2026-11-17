-- 官网合作意向表单（public API → 运营台列表）。
CREATE TYPE "CooperationIntentStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

CREATE TABLE "cooperation_intent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "company" VARCHAR(200),
    "contact" VARCHAR(300),
    "industry" VARCHAR(100),
    "region" VARCHAR(100),
    "message" VARCHAR(500),
    "status" "CooperationIntentStatus" NOT NULL DEFAULT 'NEW',
    "note" VARCHAR(1000),
    "source" VARCHAR(64) NOT NULL DEFAULT 'website',
    "ip_hash" CHAR(64),
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "handled_at" TIMESTAMP(3),
    "handled_by" UUID,

    CONSTRAINT "cooperation_intent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cooperation_intent_status_created_at_idx"
    ON "cooperation_intent"("status", "created_at");
CREATE INDEX "cooperation_intent_created_at_idx"
    ON "cooperation_intent"("created_at");
CREATE INDEX "cooperation_intent_email_idx"
    ON "cooperation_intent"("email");
