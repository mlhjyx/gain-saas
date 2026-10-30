-- R4 平台权威:撤销消费者租约与撤销出站队列(P6)
CREATE TABLE "r4_consumer_lease" (
    "schedule_id" TEXT NOT NULL,
    "component_kind" TEXT NOT NULL DEFAULT 'REVOCATION_CONSUMER',
    "generation" BIGINT NOT NULL DEFAULT 0,
    "ownership_generation" BIGINT,
    "state" TEXT NOT NULL DEFAULT 'RELEASED',
    "last_seen_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "last_tick_at" TIMESTAMP(3),
    "last_dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT 'epoch',
    "next_tick_at" TIMESTAMP(3) NOT NULL DEFAULT 'epoch',
    CONSTRAINT "r4_consumer_lease_pkey" PRIMARY KEY ("schedule_id")
);

CREATE TABLE "r4_revocation_outbox" (
    "id" UUID NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "command_jws" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "acked_at" TIMESTAMP(3),
    "last_error" TEXT,
    CONSTRAINT "r4_revocation_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "r4_revocation_outbox_state_created_at_idx" ON "r4_revocation_outbox"("state", "created_at");
