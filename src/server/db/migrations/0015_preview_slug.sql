ALTER TABLE "project_build" ADD COLUMN IF NOT EXISTS "preview_slug" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_build_preview_slug_idx" ON "project_build" ("preview_slug");
