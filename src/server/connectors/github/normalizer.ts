import type { NewSiltaEvent } from '../../../shared/types/event.js';
import type { CreateOrDeletePayload, PullRequestPayload, PushPayload, WorkflowRunPayload } from './payloadTypes.js';

/**
 * A push landing this many or more commits at once is treated as a large
 * merge (A4) rather than an ordinary landing (A2). The routing doc's own
 * language is "Δ above baseline norm" (i.e. relative to *this project's*
 * history), but the normalizer has no pack access — only the connector
 * layer sees `raw`, and nothing downstream of it may read `raw` — so it
 * can't compare against a per-project baseline. This fixed threshold is a
 * documented Phase 1 simplification; a truer baseline-relative version
 * would need either pack access inside the connector (breaking the
 * connectors→resolution layer boundary) or a structured non-raw "size"
 * field added to the event envelope. Flagged in the PR description.
 */
const LARGE_MERGE_COMMIT_THRESHOLD = 10;

function defaultBranchRef(repo: { default_branch: string }): string {
  return `refs/heads/${repo.default_branch}`;
}

export function normalizePush(orgId: string, payload: PushPayload): NewSiltaEvent | null {
  const { ref, before, after, commits, repository } = payload;
  if (!ref.startsWith('refs/heads/')) return null; // tag pushes etc.
  if (commits.length === 0) return null; // e.g. branch created pointing at an existing commit

  const isDefault = ref === defaultBranchRef(repository);
  const occurredAt = payload.head_commit?.timestamp ?? new Date().toISOString();

  return {
    org_id: orgId,
    source: 'github',
    source_account_id: repository.full_name,
    event_type: isDefault
      ? commits.length >= LARGE_MERGE_COMMIT_THRESHOLD
        ? 'code.large_merge'
        : 'code.commits_landed_default'
      : 'code.commit_pushed_non_default',
    occurred_at: new Date(occurredAt).toISOString(),
    severity_hint: 'info',
    raw: payload,
    dedupe_key: `github:push:${repository.full_name}:${before}:${after}`,
  };
}

export function normalizePullRequest(orgId: string, payload: PullRequestPayload): NewSiltaEvent | null {
  if (payload.action !== 'opened') return null; // merges are covered by the push event; other actions unmodeled in Phase 1
  const { pull_request: pr, repository, number } = payload;

  return {
    org_id: orgId,
    source: 'github',
    source_account_id: repository.full_name,
    event_type: 'code.pr_opened',
    occurred_at: new Date(pr.created_at).toISOString(),
    severity_hint: 'info',
    raw: payload,
    dedupe_key: `github:pull_request:${repository.full_name}:${number}:opened`,
  };
}

const DEPLOY_WORKFLOW_NAME = /deploy/i;

export function normalizeWorkflowRun(orgId: string, payload: WorkflowRunPayload): NewSiltaEvent | null {
  const { action, workflow_run: run, repository } = payload;

  if (action === 'requested') {
    return {
      org_id: orgId,
      source: 'github',
      source_account_id: repository.full_name,
      event_type: 'build.started',
      occurred_at: new Date(run.run_started_at).toISOString(),
      severity_hint: 'info',
      raw: payload,
      dedupe_key: `github:workflow_run:${repository.full_name}:${run.id}:requested`,
    };
  }

  if (action !== 'completed') return null; // 'in_progress' etc. carry no new signal in Phase 1

  const occurredAt = new Date(run.updated_at).toISOString();
  const dedupeKey = `github:workflow_run:${repository.full_name}:${run.id}:completed`;
  const isDeployWorkflow = DEPLOY_WORKFLOW_NAME.test(run.name);

  if (run.conclusion === 'success') {
    return {
      org_id: orgId,
      source: 'github',
      source_account_id: repository.full_name,
      event_type: 'build.succeeded',
      occurred_at: occurredAt,
      severity_hint: 'info',
      raw: payload,
      dedupe_key: dedupeKey,
    };
  }

  if (run.conclusion === 'failure') {
    return {
      org_id: orgId,
      source: 'github',
      source_account_id: repository.full_name,
      // Provisional — the resolution layer upgrades this to
      // deploy.failed_nothing_serving when the project's pack shows nothing
      // has ever served, since GitHub alone can't see host/deploy state.
      event_type: isDeployWorkflow ? 'deploy.failed_previous_serving' : 'build.failed',
      occurred_at: occurredAt,
      severity_hint: 'error',
      raw: payload,
      dedupe_key: dedupeKey,
    };
  }

  return null; // cancelled / skipped / timed_out / neutral / stale: unmodeled in Phase 1
}

/**
 * Branch create/delete webhooks are received and HMAC-verified (deliverable
 * 2) but produce no SiltaEvent: the routing table has no row for them, and
 * A1/A3 already give the resolution layer enough signal for in_progress
 * bookkeeping. Kept as an explicit function (rather than silently dropped
 * in the router) so the "why" is visible next to push/PR/workflow_run.
 */
export function normalizeCreateOrDelete(_orgId: string, _payload: CreateOrDeletePayload): NewSiltaEvent | null {
  return null;
}
