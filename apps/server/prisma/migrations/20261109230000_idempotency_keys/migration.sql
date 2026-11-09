-- P5b-05：幂等键记录（BFF 变更请求的 Idempotency-Key 去重与重放）。
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_record_workspace_id_scope_key_key"
    ON "idempotency_record"("workspace_id", "scope", "key");
CREATE INDEX "idempotency_record_expires_at_idx"
    ON "idempotency_record"("expires_at");
