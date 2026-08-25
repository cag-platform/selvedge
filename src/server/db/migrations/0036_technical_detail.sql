ALTER TABLE "orgs" ADD COLUMN "technical_detail" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "technical_detail" text;
