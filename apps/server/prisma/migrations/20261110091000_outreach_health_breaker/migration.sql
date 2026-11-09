-- ch05 P4-08：健康事件与熔断器持久态（CLOSED→OPEN→HALF_OPEN→CLOSED）。Additive，无回填。

CREATE TABLE "outreach_health_event" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "scope_ref" VARCHAR(128) NOT NULL,
    "metric" VARCHAR(32) NOT NULL,
    "window_minutes" INTEGER NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "detail" JSONB,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" VARCHAR(200),
    CONSTRAINT "outreach_health_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_health_event_workspace_id_detected_at_idx"
    ON "outreach_health_event"("workspace_id", "detected_at");

CREATE TABLE "outreach_breaker" (
    "workspace_id" UUID NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "scope_ref" VARCHAR(128) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'CLOSED',
    "reason" VARCHAR(64),
    "detail" JSONB,
    "opened_at" TIMESTAMP(3),
    "half_open_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by" VARCHAR(200),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outreach_breaker_pkey" PRIMARY KEY ("workspace_id", "scope", "scope_ref")
);
