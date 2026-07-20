CREATE TABLE "devices" (
	"org_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_org_id_token_pk" PRIMARY KEY("org_id","token")
);
