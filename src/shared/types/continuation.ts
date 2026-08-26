export type ContinuationState = 'collecting' | 'reviewing' | 'ready' | 'converted' | 'abandoned';
export type ContinuationSourceKind = 'repository' | 'imported_thread' | 'pasted_note' | 'document' | 'live_url';
export type SourceFreshness = 'current' | 'aging' | 'stale' | 'unknown';
export type ClaimStatus = 'understood' | 'needs_confirmation' | 'still_missing' | 'superseded';
export type ClaimConfidence = 'confirmed' | 'supported' | 'tentative';
export type ClaimConsequence = 'blocking' | 'high' | 'normal' | 'low';

export type ClaimEvidence = {
  source_id: string;
  kind: ContinuationSourceKind;
  label: string;
  observed_at: string;
  version: string | null;
  freshness: SourceFreshness;
  limitations: string[];
};

export type ContinuationSource = {
  id: string;
  kind: ContinuationSourceKind;
  title: string;
  source_ref: string;
  observed_at: string;
  version: string | null;
  freshness: SourceFreshness;
  limitations: string[];
  has_content: boolean;
};

export type ProjectBriefClaim = {
  id: string;
  key: string;
  group: string;
  text: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  consequence: ClaimConsequence;
  evidence: ClaimEvidence[];
  confirmed_value: unknown | null;
  destination: DeepLinkDestination;
};

export type ProjectBrief = {
  continuation_id: string;
  project: { id: string; name: string };
  generated_at: string;
  understood: ProjectBriefClaim[];
  needs_confirmation: ProjectBriefClaim[];
  still_missing: ProjectBriefClaim[];
  questions_remaining: number;
  can_continue: boolean;
  sources: ContinuationSource[];
};

export type ContextHealth = {
  project: { id: string; name: string };
  status: 'healthy' | 'needs_attention' | 'limited';
  generated_at: string;
  summary: string;
  counts: { total: number; current: number; aging: number; stale: number; unknown: number; limited: number; conflicting: number };
  sources: ContinuationSource[];
  gaps: string[];
};

export type HandoffReceipt = {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  created_at: string;
  included: Array<{ kind: string; count: number; detail?: string }>;
  omitted: Array<{ kind: string; count: number; reason: string }>;
  repository: { project_id: string | null; staged_changes_ready: boolean | null };
  estimated_tokens: number;
  transcript_tokens: number;
  destination: DeepLinkDestination;
};

export type DeepLinkDestination = {
  kind: 'project' | 'thread' | 'decision' | 'project_brief_claim' | 'handoff_receipt' | 'run_evidence' | 'card_evidence';
  web_path: string;
  ios_path: string;
  project_id?: string;
  thread_id?: string;
  decision_id?: string;
  continuation_id?: string;
  claim_id?: string;
  receipt_id?: string;
  run_id?: string;
  card_id?: string;
};
