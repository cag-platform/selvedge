ALTER TABLE "digests" ADD COLUMN "voice" text DEFAULT 'mechanical' NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "mechanical_text" text;