CREATE TABLE IF NOT EXISTS "narration_library" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"phrasing" jsonb NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"negative_feedback_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "narration_library_uses" (
	"library_id" text NOT NULL,
	"org_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "narration_library_uses_library_id_org_id_pk" PRIMARY KEY("library_id","org_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "narration_library_fingerprint_idx" ON "narration_library" USING btree ("fingerprint");