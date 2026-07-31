CREATE TABLE IF NOT EXISTS "project_beacons" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "project_beacons_org_id_project_id_pk" PRIMARY KEY("org_id","project_id"),
	CONSTRAINT "project_beacons_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "error_rate_state" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text DEFAULT 'default' NOT NULL,
	"baseline" double precision,
	"windows_seen" integer DEFAULT 0 NOT NULL,
	"consecutive_elevated" integer DEFAULT 0 NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_rate_state_org_id_project_id_source_id_pk" PRIMARY KEY("org_id","project_id","source_id")
);
