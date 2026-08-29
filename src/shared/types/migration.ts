export type MigrationSource = 'replit' | 'lovable' | 'bolt' | 'base44' | 'github' | 'codex' | 'claude-code' | 'cursor' | 'other';
export type ProjectMapStatus = 'found' | 'not_detected' | 'needs_access';

export type ProjectMapItem = {
  kind: 'application' | 'database' | 'auth' | 'storage' | 'job' | 'integration' | 'secret' | 'domain' | 'hosting';
  label: string;
  status: ProjectMapStatus;
  evidence: string[];
  note: string;
};

export type MigrationProjectMap = {
  schema_version: 1;
  generated_at: string;
  files_inspected: number;
  stack: string[];
  items: ProjectMapItem[];
  limitations: string[];
};

export type MigrationPlanStep = {
  id: 'inspect' | 'connect' | 'workspace' | 'configure' | 'preview' | 'verify' | 'ship';
  label: string;
  state: 'complete' | 'ready' | 'blocked' | 'pending' | 'approval_required';
  owner: 'selvedge' | 'migration_agent' | 'verification_agent' | 'customer';
  detail: string;
  blockers: string[];
};

export type MigrationPlan = {
  schema_version: 1;
  generated_at: string;
  ready_to_start: boolean;
  steps: MigrationPlanStep[];
  next_action: string;
};

export type MigrationVerification = {
  schema_version: 1;
  status: 'passed' | 'failed' | 'inconclusive';
  verifier: 'selvedge-preview-verifier';
  independent_from_migration_agent: true;
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'unavailable'; detail: string }>;
  screenshot_artifact_ids: string[];
  screenshot_artifacts: Array<{ id: string; route: string; viewport: 'desktop' | 'mobile' }>;
  console_errors: string[];
  failed_requests: Array<{ url: string; status: number | null; detail: string }>;
  routes_checked: string[];
  guided_journey: { status: 'passed' | 'failed' | 'unavailable'; name: string; steps: Array<{ label: string; intent: string; outcome: 'passed' | 'failed'; detail: string }> };
  limitations: string[];
  verified_at: string;
};

export type MigrationJourney = {
  id: string;
  project_id: string;
  source: MigrationSource;
  state: 'mapped' | 'copying' | 'preview_ready' | 'verified' | 'cutover_ready' | 'complete' | 'failed';
  original_untouched: boolean;
  project_map: MigrationProjectMap;
  migration_plan: MigrationPlan;
  verification: MigrationVerification | null;
  preview: { state: 'ready' | 'pending' | 'error' | 'none'; url: string | null; message: string | null };
  destinations: { repository?: string; hosting?: string; database?: string };
  created_at: string;
  updated_at: string;
};
