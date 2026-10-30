-- 内嵌模型网关:上游厂商、公开模型别名路由、调用元数据日志。

CREATE TABLE "ai_provider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_cipher" TEXT NOT NULL,
    "headers" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_model_route" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_route_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "model_call_log" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "provider_id" UUID,
    "alias" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "http_status" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_call_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_name_key" ON "ai_provider"("name");
CREATE UNIQUE INDEX "ai_model_route_alias_provider_id_key" ON "ai_model_route"("alias", "provider_id");
CREATE INDEX "ai_model_route_alias_idx" ON "ai_model_route"("alias");
CREATE INDEX "model_call_log_at_idx" ON "model_call_log"("at");

ALTER TABLE "ai_model_route"
  ADD CONSTRAINT "ai_model_route_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "ai_provider"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "model_call_log"
  ADD CONSTRAINT "model_call_log_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "ai_provider"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
