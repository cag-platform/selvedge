ALTER TABLE "project_build" ADD COLUMN "dirty_run_id" text;
ALTER TABLE "project_build" ADD COLUMN "dirty_thread_id" text;
ALTER TABLE "project_build" ADD COLUMN "dirty_agent" text;
ALTER TABLE "project_build" ADD COLUMN "dirty_observed_at" timestamp with time zone;
