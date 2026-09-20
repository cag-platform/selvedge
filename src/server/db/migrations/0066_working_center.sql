ALTER TABLE agent_runs ADD COLUMN owner_id text;
ALTER TABLE agent_runs ADD COLUMN request_key text;
ALTER TABLE agent_runs ADD COLUMN run_role text NOT NULL DEFAULT 'builder';
ALTER TABLE agent_runs ADD COLUMN capsule_id text;
ALTER TABLE agent_runs ADD COLUMN lifecycle text NOT NULL DEFAULT 'queued';
ALTER TABLE agent_runs ADD COLUMN runtime_facts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN event_version integer NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN last_activity_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN reviewed_at timestamptz;
UPDATE agent_runs SET lifecycle = CASE status WHEN 'running' THEN 'working' WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'queued' END,
  reviewed_at = CASE WHEN status = 'succeeded' THEN finished_at ELSE NULL END;
CREATE UNIQUE INDEX agent_runs_request_key_idx ON agent_runs(org_id, project_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX agent_runs_unreviewed_idx ON agent_runs(org_id, project_id) WHERE reviewed_at IS NULL;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_role_check CHECK (run_role IN ('builder','consultant'));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lifecycle_check CHECK (lifecycle IN ('queued','starting','working','needs_you','verifying','ready','failed','cancelled'));
ALTER TABLE project_build ADD COLUMN lease_owner text;
ALTER TABLE project_build ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE project_build ADD COLUMN workspace_state text NOT NULL DEFAULT 'inactive';
ALTER TABLE project_build ADD COLUMN provisioning_key text;
UPDATE project_build SET workspace_state = 'unknown' WHERE sandbox_id IS NOT NULL;
CREATE INDEX project_build_idle_lease_idx ON project_build(lease_expires_at) WHERE lease_owner IS NULL AND lease_expires_at IS NOT NULL;
CREATE TABLE agent_run_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  event_key text NOT NULL,
  sequence integer NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, run_id, event_key),
  UNIQUE(org_id, run_id, sequence)
);
CREATE INDEX agent_run_events_run_idx ON agent_run_events(org_id, run_id, sequence);
CREATE FUNCTION prevent_run_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Run events are append-only';
END $$;
CREATE TRIGGER agent_run_events_immutable BEFORE UPDATE OR DELETE ON agent_run_events FOR EACH ROW EXECUTE FUNCTION prevent_run_event_mutation();
