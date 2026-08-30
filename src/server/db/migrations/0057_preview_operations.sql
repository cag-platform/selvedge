ALTER TABLE "project_build" ADD COLUMN "preview_operation_status" text;
ALTER TABLE "project_build" ADD COLUMN "preview_operation_message" text;
ALTER TABLE "project_build" ADD COLUMN "preview_operation_started_at" timestamp with time zone;
