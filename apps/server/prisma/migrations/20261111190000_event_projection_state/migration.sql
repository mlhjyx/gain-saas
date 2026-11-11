CREATE TYPE "EventProjectionStatus" AS ENUM ('PENDING', 'APPLIED', 'QUARANTINED');

-- Existing receipts stay unclassified so the migration never replays historical effects.
ALTER TABLE "event_inbox"
    ADD COLUMN "aggregate_id" TEXT,
    ADD COLUMN "schema_version" INTEGER,
    ADD COLUMN "projection_status" "EventProjectionStatus",
    ADD COLUMN "projection_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "projection_next_attempt_at" TIMESTAMP(3),
    ADD COLUMN "projection_error" TEXT;
