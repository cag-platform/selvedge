ALTER TABLE "agent_messages" ADD COLUMN "run_id" text;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "changed_paths" jsonb;
