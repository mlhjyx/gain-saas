-- 推理模型的最小输出预算(含 reasoning tokens),避免引擎 8192 上限被推理耗尽。
ALTER TABLE "ai_provider"
  ADD COLUMN "min_output_tokens" INTEGER;
