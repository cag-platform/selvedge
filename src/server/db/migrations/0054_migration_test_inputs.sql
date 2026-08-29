CREATE TABLE IF NOT EXISTS migration_test_inputs (
  org_id text NOT NULL,
  project_id text NOT NULL,
  journey_id text NOT NULL,
  step_id text NOT NULL,
  input_id text NOT NULL,
  value_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, journey_id, step_id, input_id)
);
CREATE INDEX IF NOT EXISTS migration_test_inputs_expiry_idx ON migration_test_inputs (expires_at);
