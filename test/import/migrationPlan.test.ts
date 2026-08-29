import { describe, expect, it } from 'vitest';
import { buildMigrationPlan, rebuildMigrationPlan, recordMigrationVerification, recordPreviewPreparation, recordWorkspacePreparation } from '../../src/server/import/migrationPlan.js';
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

  it('keeps ship blocked after destinations are chosen until verification passes', () => {
    const plan = buildMigrationPlan(map, { repository: 'acme/app', hosting: 'railway', database: 'neon' });
    expect(plan.steps.find((step) => step.id === 'ship')?.state).toBe('blocked');
    const verified = recordMigrationVerification(plan, { schema_version: 1, status: 'passed', verifier: 'selvedge-preview-verifier', independent_from_migration_agent: true, checks: [], screenshot_artifact_ids: [], screenshot_artifacts: [], console_errors: [], failed_requests: [], routes_checked: [], guided_journey: { status: 'passed', name: 'Test', steps: [] }, limitations: [], verified_at: new Date().toISOString() });
    expect(verified.steps.find((step) => step.id === 'ship')?.state).toBe('blocked');
    expect(verified.steps.find((step) => step.id === 'ship')?.blockers).not.toContain('Independent verification must pass before shipping.');
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

  it('records a live preview or a precise startup blocker', () => {
    const workspace = recordWorkspacePreparation(buildMigrationPlan(map, { repository: 'acme/app' }), { ok: true });
    const ready = recordPreviewPreparation(workspace, { state: 'ready', message: null });
    expect(ready.steps.find((step) => step.id === 'configure')?.state).toBe('complete');
    expect(ready.steps.find((step) => step.id === 'preview')?.state).toBe('complete');
    expect(ready.steps.find((step) => step.id === 'verify')?.state).toBe('pending');
    const failed = recordPreviewPreparation(workspace, { state: 'error', message: 'The app needs DATABASE_URL.' });
    expect(failed.steps.find((step) => step.id === 'preview')?.blockers).toEqual(['The app needs DATABASE_URL.']);
  });

  it('keeps runtime progress when the owner changes destinations', () => {
    const ready = recordPreviewPreparation(recordWorkspacePreparation(buildMigrationPlan(map, { repository: 'acme/app' }), { ok: true }), { state: 'ready', message: null });
    const rebuilt = rebuildMigrationPlan(map, { repository: 'acme/app', hosting: 'vercel', database: 'neon' }, ready);
    expect(rebuilt.steps.find((step) => step.id === 'workspace')?.state).toBe('complete');
    expect(rebuilt.steps.find((step) => step.id === 'preview')?.state).toBe('complete');
    expect(rebuilt.steps.find((step) => step.id === 'ship')?.state).toBe('blocked');
  });
});
