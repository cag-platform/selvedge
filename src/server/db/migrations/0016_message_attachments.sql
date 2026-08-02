CREATE TABLE IF NOT EXISTS "agent_message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_message_id" text NOT NULL,
	"mime" text NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_message_attachments_message_idx" ON "agent_message_attachments" ("agent_message_id");
