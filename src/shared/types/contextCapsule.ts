import type { AgentId } from '../agents.js';

/**
 * The future Project Brain's interchange shape. This is deliberately an input
 * contract only: compiling a capsule never creates, promotes, or mutates a
 * claim. The knowledge engine owns those governance transitions.
 */
export type ProjectKnowledgeState = 'candidate' | 'supported' | 'graduated' | 'verified' | 'superseded' | 'retired';

export type ProjectKnowledgeClaim = {
  id: string;
  claim: string;
  type: string;
  scope: string;
  evidence: Array<{ source: string; reference?: string }>;
  provenance: string;
  confidence: number | null;
  status: ProjectKnowledgeState;
  effective_at: string | null;
  supersedes?: string | null;
  outcome_history?: Array<{ outcome: string; observed_at: string }>;
};

export type ContextFactSource = 'project_pack' | 'project_knowledge' | 'thread' | 'agent_run' | 'sandbox' | 'git' | 'verification' | 'repository';

export type ContextFact = {
  value: string;
  source: ContextFactSource;
  observed_at: string;
  freshness: 'current' | 'recent' | 'historical' | 'unknown';
  reference?: string;
};

export type TaskContextCapsule = {
  schema_version: 1;
  capsule_id: string;
  content_hash: string;
  generated_at: string;
  project_id: string | null;
  thread_id: string;
  /** Durable/project knowledge. Never inferred from the live execution section. */
  known_already: {
    product_intent: ContextFact[];
    architecture: ContextFact[];
    business_rules_and_constraints: ContextFact[];
    accepted_decisions: ContextFact[];
    prior_failures_and_outcomes: ContextFact[];
    graduated_project_knowledge: ProjectKnowledgeClaim[];
  };
  /** Point-in-time execution observations. Never promoted to durable truth here. */
  observed_now: {
    current_objective: ContextFact | null;
    latest_owner_request: ContextFact;
    open_questions: ContextFact[];
    current_builder: AgentId | null;
    active_run: { id: string; status: string; started_at: string | null } | null;
    changed_files: ContextFact[];
    diff_summary: ContextFact | null;
    latest_verification: ContextFact | null;
    blocker: ContextFact | null;
    next_intended_action: ContextFact | null;
    relevant_code_evidence: ContextFact[];
    referenced_prior_answers: ContextFact[];
  };
  omissions: Array<{ item: string; reason: string }>;
};

