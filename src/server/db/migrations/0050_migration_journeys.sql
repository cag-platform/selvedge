CREATE TABLE IF NOT EXISTS migration_journeys (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  source text NOT NULL,
  state text NOT NULL,
  original_untouched boolean NOT NULL DEFAULT true,
  project_map jsonb NOT NULL,
  destinations jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS migration_journeys_org_project_idx ON migration_journeys (org_id, project_id);
