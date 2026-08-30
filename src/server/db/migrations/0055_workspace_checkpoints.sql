ALTER TABLE "project_build" ADD COLUMN "checkpoint_archive_base64" text;
ALTER TABLE "project_build" ADD COLUMN "checkpoint_sha256" text;
ALTER TABLE "project_build" ADD COLUMN "checkpoint_bytes" integer;
ALTER TABLE "project_build" ADD COLUMN "checkpoint_created_at" timestamp with time zone;
