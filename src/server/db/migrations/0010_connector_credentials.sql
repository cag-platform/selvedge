CREATE TABLE IF NOT EXISTS "connector_credentials" (
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text DEFAULT 'api_key' NOT NULL,
	"value_enc" text NOT NULL,
	"label" text,
	"last4" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_org_id_provider_pk" PRIMARY KEY("org_id","provider")
);
