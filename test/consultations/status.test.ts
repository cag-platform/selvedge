import { describe, expect, it } from 'vitest';
import { consultationStatuses } from '../../src/server/consultations/status.js';
import type { TaskContextCapsule } from '../../src/shared/types/contextCapsule.js';

const capsule = {
  capsule_id: 'cap_1',
  observed_now: { changed_files: [{ value: 'src/a.ts' }], latest_verification: null },
  omissions: [{ item: 'live sandbox worktree', reason: 'unavailable' }],
} as unknown as TaskContextCapsule;

describe('deterministic consultation status', () => {
  it('reports partial evidence without turning an available opinion into truth', () => {
    const [status] = consultationStatuses([
      { id: 'p', role: 'owner', meta: { context_capsule: capsule } },
      { id: 'm', role: 'switch', meta: { consultation: { id: 'c', prompt_id: 'p', agents: ['claude', 'gpt'] } } },
      { id: 'a', role: 'agent', meta: { consultation_id: 'c', answered_by: 'claude', consultation_lane: { status: 'answered' } } },
      { id: 'b', role: 'agent', meta: { consultation_id: 'c', answered_by: 'gpt', consultation_lane: { status: 'failed', failure_code: 'model_unavailable', retryable: false } } },
    ]);
    expect(status).toMatchObject({ state: 'partial', answered: ['claude'], failed: [{ agent: 'gpt', code: 'model_unavailable', retryable: false }] });
    expect(status!.summary).toContain('live repository state unavailable');
    expect(status!.summary).toContain('no current verification');
    expect(status!.outcome).toMatch(/preliminary/i);
    expect(status!.receipt.omissions).toContain('live sandbox worktree');
  });
});
