import { describe, it, expect } from 'vitest';
import {
  normalizeCreateOrDelete,
  normalizePullRequest,
  normalizePush,
  normalizeWorkflowRun,
} from '../../../src/server/connectors/github/normalizer.js';
import type { PullRequestPayload, PushPayload, WorkflowRunPayload } from '../../../src/server/connectors/github/payloadTypes.js';

const repo = { full_name: 'cag-platform/loom', default_branch: 'main' };

describe('normalizePush', () => {
  it('maps a default-branch push to code.commits_landed_default', () => {
    const payload: PushPayload = {
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'bbb',
      created: false,
      deleted: false,
      commits: [{ id: 'bbb', message: 'fix bug' }],
      head_commit: { id: 'bbb', timestamp: '2026-07-19T10:00:00Z' },
      repository: repo,
    };
    const event = normalizePush('org_1', payload);
    expect(event?.event_type).toBe('code.commits_landed_default');
    expect(event?.source_account_id).toBe('cag-platform/loom');
    expect(event?.dedupe_key).toBe('github:push:cag-platform/loom:aaa:bbb');
  });

  it('maps a non-default-branch push to code.commit_pushed_non_default', () => {
    const payload: PushPayload = {
      ref: 'refs/heads/feature/x',
      before: 'aaa',
      after: 'bbb',
      created: false,
      deleted: false,
      commits: [{ id: 'bbb', message: 'wip' }],
      head_commit: { id: 'bbb', timestamp: '2026-07-19T10:00:00Z' },
      repository: repo,
    };
    const event = normalizePush('org_1', payload);
    expect(event?.event_type).toBe('code.commit_pushed_non_default');
  });

  it('maps a large default-branch push to code.large_merge', () => {
    const payload: PushPayload = {
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'zzz',
      created: false,
      deleted: false,
      commits: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, message: `commit ${i}` })),
      head_commit: { id: 'zzz', timestamp: '2026-07-19T10:00:00Z' },
      repository: repo,
    };
    const event = normalizePush('org_1', payload);
    expect(event?.event_type).toBe('code.large_merge');
  });

  it('ignores tag pushes', () => {
    const payload: PushPayload = {
      ref: 'refs/tags/v1.0.0',
      before: 'aaa',
      after: 'bbb',
      created: true,
      deleted: false,
      commits: [],
      head_commit: null,
      repository: repo,
    };
    expect(normalizePush('org_1', payload)).toBeNull();
  });

  it('ignores a push with no commits', () => {
    const payload: PushPayload = {
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'aaa',
      created: true,
      deleted: false,
      commits: [],
      head_commit: null,
      repository: repo,
    };
    expect(normalizePush('org_1', payload)).toBeNull();
  });
});

describe('normalizePullRequest', () => {
  const base: PullRequestPayload = {
    action: 'opened',
    number: 42,
    pull_request: {
      title: 'Add pricing snapshot',
      merged: false,
      created_at: '2026-07-19T09:00:00Z',
      updated_at: '2026-07-19T09:00:00Z',
      html_url: 'https://github.com/cag-platform/loom/pull/42',
      head: { ref: 'feature/pricing-snapshot' },
    },
    repository: repo,
  };

  it('maps action=opened to code.pr_opened', () => {
    const event = normalizePullRequest('org_1', base);
    expect(event?.event_type).toBe('code.pr_opened');
    expect(event?.dedupe_key).toBe('github:pull_request:cag-platform/loom:42:opened');
  });

  it('ignores non-opened actions (merges are covered by the push event)', () => {
    expect(normalizePullRequest('org_1', { ...base, action: 'closed' })).toBeNull();
    expect(normalizePullRequest('org_1', { ...base, action: 'synchronize' })).toBeNull();
  });
});

describe('normalizeWorkflowRun', () => {
  function run(overrides: Partial<WorkflowRunPayload['workflow_run']> = {}): WorkflowRunPayload {
    return {
      action: 'completed',
      workflow_run: {
        id: 1,
        name: 'CI',
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-07-19T10:00:00Z',
        updated_at: '2026-07-19T10:03:00Z',
        html_url: 'https://github.com/cag-platform/loom/actions/runs/1',
        ...overrides,
      },
      repository: repo,
    };
  }

  it('maps action=requested to build.started', () => {
    const event = normalizeWorkflowRun('org_1', { ...run(), action: 'requested' });
    expect(event?.event_type).toBe('build.started');
  });

  it('ignores action=in_progress', () => {
    expect(normalizeWorkflowRun('org_1', { ...run(), action: 'in_progress' })).toBeNull();
  });

  it('maps a successful completion to build.succeeded', () => {
    const event = normalizeWorkflowRun('org_1', run({ conclusion: 'success' }));
    expect(event?.event_type).toBe('build.succeeded');
    expect(event?.severity_hint).toBe('info');
  });

  it('maps a failed non-deploy workflow to build.failed', () => {
    const event = normalizeWorkflowRun('org_1', run({ name: 'CI', conclusion: 'failure' }));
    expect(event?.event_type).toBe('build.failed');
    expect(event?.severity_hint).toBe('error');
  });

  it('maps a failed deploy-named workflow to deploy.failed_previous_serving (provisional)', () => {
    const event = normalizeWorkflowRun('org_1', run({ name: 'Deploy to Railway', conclusion: 'failure' }));
    expect(event?.event_type).toBe('deploy.failed_previous_serving');
  });

  it('ignores cancelled/neutral conclusions', () => {
    expect(normalizeWorkflowRun('org_1', run({ conclusion: 'cancelled' }))).toBeNull();
    expect(normalizeWorkflowRun('org_1', run({ conclusion: 'neutral' }))).toBeNull();
  });
});

describe('normalizeCreateOrDelete', () => {
  it('always returns null (received/verified, but no routing row exists yet)', () => {
    expect(
      normalizeCreateOrDelete('org_1', { ref: 'feature/x', ref_type: 'branch', repository: repo }),
    ).toBeNull();
  });
});
