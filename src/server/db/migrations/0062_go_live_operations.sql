ALTER TABLE "project_build" ADD COLUMN "go_live_status" text;
ALTER TABLE "project_build" ADD COLUMN "go_live_message" text;
ALTER TABLE "project_build" ADD COLUMN "go_live_started_at" timestamp with time zone;
