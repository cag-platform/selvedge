-- Where an imported thread came from.
--
-- A conversation imported from ChatGPT, Claude or Gemini is still a thread —
-- it lists in the rail, it searches, it is part of the history. What it is
-- NOT is something that was said to Selvedge, and the record has to keep that
-- straight forever, so the provenance is columns on the thread rather than a
-- note in the text.
--
-- The unique index is the dedupe: importing the same export twice is a thing
-- people do (they forget, or the first attempt half-failed), and the second
-- one must not double every conversation. The database enforces it rather
-- than the importer remembering to check.
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "imported_from" text;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "import_source_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_import_unique_idx"
  ON "threads" ("org_id","imported_from","import_source_id")
  WHERE "imported_from" IS NOT NULL;
