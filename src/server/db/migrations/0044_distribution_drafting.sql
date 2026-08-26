ALTER TABLE "distribution_drafts" ADD COLUMN "initial_body" text DEFAULT '' NOT NULL;
ALTER TABLE "distribution_drafts" ADD COLUMN "final_body" text;
ALTER TABLE "distribution_drafts" ADD COLUMN "response_mode" text DEFAULT 'HELP_ONLY' NOT NULL;
ALTER TABLE "distribution_drafts" ADD COLUMN "prompt_version" text DEFAULT 'v1' NOT NULL;
