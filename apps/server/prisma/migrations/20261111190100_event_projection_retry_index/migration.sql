-- Keep the concurrent index in a standalone migration.
CREATE INDEX CONCURRENTLY "event_inbox_projection_retry_idx"
    ON "event_inbox" ("workspace_id", "projection_status", "projection_next_attempt_at");
