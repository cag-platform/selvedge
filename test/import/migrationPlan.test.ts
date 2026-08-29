import { describe, expect, it } from 'vitest';
import { buildMigrationPlan, recordWorkspacePreparation } from '../../src/server/import/migrationPlan.js';
import type { MigrationProjectMap } from '../../src/shared/types/migration.js';

const map: MigrationProjectMap = {
  schema_version: 1,
  generated_at: '2026-08-28T00:00:00.000Z',
  files_inspected: 12,
  stack: ['Next.js'],
  items: [
    { kind: 'application', label: 'Next.js', status: 'found', evidence: ['package.json'], note: '' },
    { kind: 'database', label: 'Database', status: 'found', evidence: ['src/db.ts'], note: '' },
    { kind: 'secret', label: 'Environment secrets', status: 'found', evidence: ['.env.example'], note: '' },
    { kind: 'hosting', label: 'Hosting', status: 'needs_access', evidence: [], note: '' },
  ],
  limitations: [],
};

describe('migration planner', () => {
  it('turns observed services into explicit access blockers and preserves the approval boundary', () => {
    const plan = buildMigrationPlan(map, { repository: 'acme/app' }, new Date('2026-08-28T01:00:00Z'));
    expect(plan.ready_to_start).toBe(true);
    expect(plan.steps.find((step) => step.id === 'connect')?.blockers).toHaveLength(2);
    expect(plan.steps.find((step) => step.id === 'ship')?.state).toBe('blocked');
    expect(plan.next_action).toContain('database');
  });

  it('makes ship an approval—not an automatic action—after destinations are chosen', () => {
    const plan = buildMigrationPlan(map, { repository: 'acme/app', hosting: 'railway', database: 'neon' });
    expect(plan.steps.find((step) => step.id === 'ship')?.state).toBe('approval_required');
    expect(plan.steps.find((step) => step.id === 'verify')?.owner).toBe('verification_agent');
  });

  it('records workspace success and retryable failure without advancing production', () => {
    const plan = buildMigrationPlan(map, { repository: 'acme/app' });
    const ready = recordWorkspacePreparation(plan, { ok: true });
    expect(ready.steps.find((step) => step.id === 'workspace')?.state).toBe('complete');
    expect(ready.steps.find((step) => step.id === 'ship')?.state).toBe('blocked');
    const failed = recordWorkspacePreparation(plan, { ok: false, reason: 'GitHub access expired.' });
    expect(failed.steps.find((step) => step.id === 'workspace')?.blockers).toEqual(['GitHub access expired.']);
  });
});
