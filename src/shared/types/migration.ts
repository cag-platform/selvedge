export type MigrationSource = 'replit' | 'lovable' | 'bolt' | 'base44' | 'github' | 'other';
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

export type MigrationJourney = {
  id: string;
  project_id: string;
  source: MigrationSource;
  state: 'mapped' | 'copying' | 'preview_ready' | 'verified' | 'cutover_ready' | 'complete' | 'failed';
  original_untouched: boolean;
  project_map: MigrationProjectMap;
  destinations: { repository?: string; hosting?: string; database?: string };
  created_at: string;
  updated_at: string;
};
