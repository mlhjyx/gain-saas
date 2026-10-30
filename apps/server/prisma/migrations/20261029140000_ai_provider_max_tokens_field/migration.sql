-- 兼容新式 OpenAI 推理模型:max_tokens 字段名可按厂商切换。
ALTER TABLE "ai_provider"
  ADD COLUMN "max_tokens_field" TEXT NOT NULL DEFAULT 'max_tokens';
