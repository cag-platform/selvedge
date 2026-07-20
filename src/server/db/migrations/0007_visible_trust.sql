ALTER TABLE "narrations" ADD COLUMN "confidence" text;--> statement-breakpoint
CREATE TABLE "trust_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"prior_narration_id" text,
	"contradicting_event_id" text,
	"detail" text,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trust_incidents_org_idx" ON "trust_incidents" USING btree ("org_id","created_at");
