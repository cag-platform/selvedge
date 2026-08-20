-- The Inbox, server side.
--
-- llm_usage.thread_id: a general thread's turns are ordinary model calls and
-- meter into llm_usage like everything else — but the Inbox shows what a
-- CONVERSATION has cost, and that join has to live somewhere. Here rather than
-- in a second ledger: two tables counting the same money is exactly the hazard
-- the existing agent_runs / llm_usage split already has to be held apart by
-- hand.
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_thread_idx" ON "llm_usage" ("org_id","thread_id");
--> statement-breakpoint
-- agent_runs.agent: WHICH agent did this work. The model column says what it
-- ran on; once a thread can change builders mid-task, "who did this" is a
-- different question with a different answer, and Phase 4's sentence ("the
-- change from Monday's Codex session") needs the answer stored rather than
-- inferred. Existing rows are Claude Code, which is the only builder there was.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "agent" text;
--> statement-breakpoint
UPDATE "agent_runs" SET "agent" = 'claude-code' WHERE "agent" IS NULL;
--> statement-breakpoint
-- project_build.codex_session_id: the second builder's own CLI session. A
-- separate column rather than a shared one because they are separate
-- conversations inside the same sandbox — resuming the other agent's session
-- would hand Codex Claude's transcript and call it continuity.
ALTER TABLE "project_build" ADD COLUMN IF NOT EXISTS "codex_session_id" text;
