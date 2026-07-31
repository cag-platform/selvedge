ALTER TABLE "packs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "muted_at" timestamp with time zone;
