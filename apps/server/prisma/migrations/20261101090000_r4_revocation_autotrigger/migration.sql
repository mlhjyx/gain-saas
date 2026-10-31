-- P9：平台撤销的自动触发（逻辑请求 + 追加式尝试 + 策略状态镜像 + 序列计数器）。
-- 只新增表与索引；旧 r4_revocation_outbox 保持原样（P6 遗留，从未有写入方）。
CREATE TABLE "r4_revocation_request" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "note" TEXT,
  "dedupe_key" TEXT,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "delivery_unknown" BOOLEAN NOT NULL DEFAULT false,
  "fence_sequence" BIGINT NOT NULL,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMPTZ(3),
  "next_attempt_at" TIMESTAMPTZ(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "ack_receipt_id" UUID,
  "ack_generation" BIGINT,
  "ack_committed_at" TIMESTAMPTZ(3),
  "ack_in_flight_attempts" BIGINT,
  "ack_sha256" TEXT,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "r4_revocation_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "r4_revocation_request_dedupe_key_key" UNIQUE ("dedupe_key"),
  CONSTRAINT "r4_revocation_request_schedule_sequence_key" UNIQUE ("schedule_id", "fence_sequence"),
  CONSTRAINT "r4_revocation_request_schedule_check" CHECK (
    "schedule_id" IN ('acq-sweep', 'intent-sweep', 'sanctions-refresh', 'patents-cache-refresh')),
  CONSTRAINT "r4_revocation_request_reason_check" CHECK (
    "reason_code" IN ('POLICY_DISABLED', 'SECURITY_RESPONSE', 'OPERATOR_HOLD')),
  CONSTRAINT "r4_revocation_request_source_check" CHECK (
    "source" IN ('POLICY_STATE', 'BINDING_REVOKED', 'OPERATOR')),
  CONSTRAINT "r4_revocation_request_state_check" CHECK (
    "state" IN ('PENDING_CONFIRMATION', 'PENDING', 'ACKED', 'NO_LIVE_TARGET', 'BLOCKED', 'STORED_STATE_CONFLICT', 'CANCELLED')),
  CONSTRAINT "r4_revocation_request_sequence_check" CHECK ("fence_sequence" > 0),
  CONSTRAINT "r4_revocation_request_ack_check" CHECK (
    num_nonnulls("ack_receipt_id", "ack_generation", "ack_committed_at", "ack_in_flight_attempts", "ack_sha256") = 0
    OR (
      num_nonnulls("ack_receipt_id", "ack_generation", "ack_committed_at", "ack_in_flight_attempts", "ack_sha256") = 5
      AND "ack_generation" > 0
      AND "ack_in_flight_attempts" >= 0
      AND "ack_sha256" ~ '^[0-9a-f]{64}$'
    ))
);
CREATE INDEX "r4_revocation_request_state_next_attempt_idx"
  ON "r4_revocation_request" ("state", "next_attempt_at");
CREATE INDEX "r4_revocation_request_schedule_created_idx"
  ON "r4_revocation_request" ("schedule_id", "created_at");
-- 同一 schedule 同时只允许一个未结请求：重复触发幂等返回已有请求，避免两个请求抢同一个号段。
-- Prisma schema 无法表达部分索引，因此只存在于迁移里；交付层按同一组状态做幂等判断。
CREATE UNIQUE INDEX "r4_revocation_request_active_schedule_key"
  ON "r4_revocation_request" ("schedule_id")
  WHERE "state" IN ('PENDING_CONFIRMATION', 'PENDING', 'BLOCKED', 'STORED_STATE_CONFLICT');

CREATE TABLE "r4_revocation_attempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "command_jws" TEXT NOT NULL,
  "command_sha256" TEXT NOT NULL,
  "revocation_jti" UUID NOT NULL,
  "target_issuer" TEXT NOT NULL,
  "target_jti" UUID NOT NULL,
  "workflow_run_id" UUID NOT NULL,
  "fence_sequence" BIGINT NOT NULL,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "outcome" TEXT,
  "http_status" INTEGER,
  "error_code" TEXT,
  "ack_sha256" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "r4_revocation_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "r4_revocation_attempt_revocation_jti_key" UNIQUE ("revocation_jti"),
  CONSTRAINT "r4_revocation_attempt_request_ordinal_key" UNIQUE ("request_id", "ordinal"),
  CONSTRAINT "r4_revocation_attempt_request_fkey" FOREIGN KEY ("request_id")
    REFERENCES "r4_revocation_request" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "r4_revocation_attempt_sequence_check" CHECK ("fence_sequence" > 0),
  CONSTRAINT "r4_revocation_attempt_ordinal_check" CHECK ("ordinal" > 0),
  CONSTRAINT "r4_revocation_attempt_outcome_check" CHECK (
    "outcome" IS NULL OR "outcome" IN ('ACKED', 'SCOPE_MISMATCH', 'EXPIRED_UNCOMMITTED', 'INVALID', 'REUSED', 'SEQUENCE_CONFLICT'))
);
CREATE INDEX "r4_revocation_attempt_request_idx"
  ON "r4_revocation_attempt" ("request_id", "ordinal");

CREATE TABLE "r4_platform_policy_state" (
  "schedule_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'ENABLED',
  "revision" TEXT,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "r4_platform_policy_state_pkey" PRIMARY KEY ("schedule_id"),
  CONSTRAINT "r4_platform_policy_state_schedule_check" CHECK (
    "schedule_id" IN ('acq-sweep', 'intent-sweep', 'sanctions-refresh', 'patents-cache-refresh')),
  CONSTRAINT "r4_platform_policy_state_mode_check" CHECK ("mode" IN ('ENABLED', 'DISABLED'))
);

CREATE TABLE "r4_revocation_sequence" (
  "schedule_id" TEXT NOT NULL,
  "next_value" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "r4_revocation_sequence_pkey" PRIMARY KEY ("schedule_id"),
  CONSTRAINT "r4_revocation_sequence_value_check" CHECK ("next_value" > 0)
);
