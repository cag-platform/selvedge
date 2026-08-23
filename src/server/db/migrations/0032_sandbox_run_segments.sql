-- A sandbox is metered per PERIOD IT IS RUNNING, not per sandbox.
--
-- 0031 put a unique index on daytona_sandbox_id, which assumed one row per
-- sandbox. That is wrong for how sandboxes actually work here: one is created
-- per project and then stopped and resumed for months. Daytona bills running
-- time, so each start→stop is its own billable segment and its own row.
--
-- What must stay unique is one OPEN row per sandbox: two open rows would mean
-- two reapers each closing "the" run and metering the same seconds twice.
-- A partial unique index says exactly that and nothing more, and lets the
-- closed history grow as long as it likes.
DROP INDEX IF EXISTS "sandbox_runs_sandbox_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_runs_open_sandbox_idx"
  ON "sandbox_runs" ("daytona_sandbox_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
-- The history, for reconciliation against what Daytona says it billed us.
CREATE INDEX IF NOT EXISTS "sandbox_runs_sandbox_history_idx" ON "sandbox_runs" ("daytona_sandbox_id","started_at");
