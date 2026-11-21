ALTER TABLE "task_run" ADD COLUMN "execution_request_sha256" VARCHAR(64);
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_execution_request_sha256_check"
  CHECK ("execution_request_sha256" IS NULL OR "execution_request_sha256" ~ '^[a-f0-9]{64}$');
