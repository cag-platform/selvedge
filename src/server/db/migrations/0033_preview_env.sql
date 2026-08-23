-- What a preview needs to run that the repository doesn't contain.
--
-- An app built anywhere real expects a database, an API key, a signing secret.
-- A fresh checkout has none of them, which is why this only became obvious the
-- first time somebody imported a repository that had been running in production
-- and the preview died on ECONNREFUSED 5432.
--
-- The values are AES-256-GCM, same vault as connector credentials, bound to
-- (org, 'preview-env:project') as additional authenticated data so a blob
-- lifted from one project cannot be decrypted as another's. The plaintext is
-- never a column and never returned by an API — key_names exists so a screen
-- can say which variables are set without reading what they are set to.
CREATE TABLE IF NOT EXISTS "preview_env" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "value_enc" text,
  "key_names" text[] DEFAULT '{}' NOT NULL,
  -- Off by default, and offered by the failure that would be fixed by it
  -- rather than as a checkbox nobody reads. Sandbox-only: created empty, dies
  -- with the sandbox, never touches a real database of the owner's.
  "wants_database" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "preview_env_pk" PRIMARY KEY ("org_id","project_id")
);
