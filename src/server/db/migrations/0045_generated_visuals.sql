CREATE TABLE IF NOT EXISTS "generated_visuals" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "message_id" text,
  "consultation_id" text,
  "directing_agent" text NOT NULL,
  "rendering_provider" text NOT NULL,
  "rendering_model" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "request" text NOT NULL,
  "render_prompt" text,
  "storage_key" text,
  "mime" text,
  "width" integer,
  "height" integer,
	"bytes" integer,
	"direction_ms" integer,
	"render_ms" integer,
	"storage_ms" integer,
  "error" text,
  "parent_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "generated_visuals_org_thread_idx" ON "generated_visuals" ("org_id", "thread_id");
CREATE INDEX IF NOT EXISTS "generated_visuals_consultation_idx" ON "generated_visuals" ("org_id", "consultation_id");
