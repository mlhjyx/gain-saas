-- Widen experiment arm columns from VARCHAR(8) to VARCHAR(16) so 'treatment' (9 chars)
-- and 'holdout' (7 chars) both persist cleanly without PostgreSQL P2000 value-too-long errors.
-- Pure forward additive metadata-only ALTER in PostgreSQL; preserves all existing indexes & FORCE RLS policies.
ALTER TABLE "outreach_experiment_assignment" ALTER COLUMN "arm" TYPE VARCHAR(16);
ALTER TABLE "outreach_metric_snapshot" ALTER COLUMN "arm" TYPE VARCHAR(16);
