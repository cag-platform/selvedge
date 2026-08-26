import type { DeepLinkDestination } from './continuation.js';
import type { ToolEvent } from './toolEvent.js';

export type EvidenceOutcome = 'verified' | 'probably' | 'inconclusive' | 'did_not_work' | 'stopped';
export type EvidenceStatus = 'healthy' | 'unknown' | 'needs';

export type EvidenceCheck = {
  kind: 'smoke' | 'regression' | 'acceptance' | 'project' | 'unknown';
  name: string;
  outcome: 'passed' | 'failed' | 'unavailable' | 'unknown';
  detail: string | null;
  raw_outcome: string | null;
};

export type EvidenceSheet = {
  schema_version: 1;
  project_id: string;
  source: { kind: 'run' | 'card'; id: string; thread_id: string | null };
  outcome: EvidenceOutcome;
  raw_outcome: string | null;
  status: EvidenceStatus;
  summary: string;
  explanation: string;
  changed_files: { paths: string[]; total: number; truncated: boolean };
  checks_run: EvidenceCheck[];
  acceptance_observation: EvidenceCheck | null;
  unavailable_checks: EvidenceCheck[];
  raw_evidence: {
    tools: ToolEvent[];
    acts: Array<{ at: string; kind: string; detail: string; meta?: Record<string, unknown> }>;
    truncated: boolean;
  };
  timestamps: { started_at: string | null; finished_at: string | null; generated_at: string };
  warnings: string[];
  destinations: {
    evidence: DeepLinkDestination;
    thread: DeepLinkDestination | null;
    project_history: DeepLinkDestination;
  };
};
