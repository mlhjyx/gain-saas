-- egress 策略安装审计(P3d)
CREATE TABLE "r4_egress_install_audit" (
    "id" UUID NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "from_generation" BIGINT NOT NULL,
    "to_generation" BIGINT NOT NULL,
    "policy_artifact_sha256" TEXT NOT NULL,
    "execution_envelope_sha256" TEXT NOT NULL,
    "required_cap_microusd" BIGINT NOT NULL,
    "quote_policy_revision" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "r4_egress_install_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "r4_egress_install_audit_schedule_id_at_idx" ON "r4_egress_install_audit"("schedule_id", "at");
