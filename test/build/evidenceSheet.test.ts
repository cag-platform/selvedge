import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, cards, orgs } from '../../src/server/db/schema/index.js';
import { cardEvidenceSheet, runEvidenceSheet } from '../../src/server/build/evidenceSheet.js';

describe('Evidence Sheet — a bounded projection of existing records', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => { const test = await createTestDb(); db = test.db; close = test.close; await db.insert(orgs).values({ orgId: 'org_1' }); });
  afterEach(async () => close());

  it('derives a probably run from changed files and a passing recorded check without claiming healthy', async () => {
    await db.insert(agentRuns).values({ id: 'run_1', orgId: 'org_1', projectId: 'loom', threadId: 'thread_1', prompt: 'Fix sign in', status: 'succeeded', changedPaths: ['src/auth.ts'], startedAt: new Date('2026-08-25T10:00:00Z'), finishedAt: new Date('2026-08-25T10:08:00Z') });
    await db.insert(agentMessages).values({ id: 'activity_1', orgId: 'org_1', projectId: 'loom', threadId: 'thread_1', runId: 'run_1', role: 'activity', content: 'done', meta: { run_id: 'run_1', truncated: true, tools: [{ id: 't1', name: 'Bash', detail: 'Running npm test', input: { command: 'npm test' }, ok: true }] } });
    const sheet = await runEvidenceSheet(db, 'org_1', 'loom', 'run_1');
    expect(sheet).toMatchObject({ outcome: 'probably', status: 'unknown', changed_files: { paths: ['src/auth.ts'], total: 1 }, acceptance_observation: null });
    expect(sheet?.explanation).toMatch(/no acceptance observation/i);
    expect(sheet?.checks_run[0]).toMatchObject({ outcome: 'passed', name: 'npm test' });
    expect(sheet?.warnings.join(' ')).toMatch(/truncated/i);
    expect(sheet?.destinations.evidence).toMatchObject({ kind: 'run_evidence', run_id: 'run_1', thread_id: 'thread_1' });
  });

  it('derives verified card evidence and preserves unavailable checks and raw acts', async () => {
    const at = new Date('2026-08-25T12:00:00Z');
    await db.insert(cards).values({ id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'Fix sign in', proposal: 'Fix it', risk: 'ordinary', gate: 'normal', state: 'done', verdict: 'verified', gradedBy: 'independent', estimate: { lowCents: 1, highCents: 2 }, stop: { capCents: 10, checkpointAtFractions: [] }, acts: [{ at: at.toISOString(), kind: 'completed', detail: 'Verified', meta: { verdict: 'verified', results: [{ kind: 'smoke', name: 'App responds', outcome: 'pass' }, { kind: 'acceptance', name: 'User signs in', outcome: 'pass', detail: 'Observed the signed-in screen.' }, { kind: 'regression', name: 'Browser suite', outcome: 'could_not_run', detail: 'Browser unavailable.' }] } }], createdAt: at, updatedAt: at });
    const sheet = await cardEvidenceSheet(db, 'org_1', 'loom', 'card_1');
    expect(sheet).toMatchObject({ outcome: 'verified', status: 'healthy', acceptance_observation: { outcome: 'passed', name: 'User signs in' } });
    expect(sheet?.unavailable_checks[0]).toMatchObject({ outcome: 'unavailable', name: 'Browser suite' });
    expect(sheet?.raw_evidence.acts).toHaveLength(1);
    expect(sheet?.destinations.evidence).toMatchObject({ kind: 'card_evidence', card_id: 'card_1' });
  });

  it('treats unknown future verdicts as inconclusive and discloses the raw value', async () => {
    await db.insert(agentRuns).values({ id: 'run_future', orgId: 'org_1', projectId: 'loom', prompt: 'future', status: 'succeeded', verdict: 'astonishing' });
    const sheet = await runEvidenceSheet(db, 'org_1', 'loom', 'run_future');
    expect(sheet).toMatchObject({ outcome: 'inconclusive', status: 'unknown', raw_outcome: 'astonishing' });
    expect(sheet?.warnings.join(' ')).toContain('astonishing');
  });

  it('does not trust a stored verified verdict without acceptance evidence', async () => {
    await db.insert(agentRuns).values({ id: 'run_claimed', orgId: 'org_1', projectId: 'loom', prompt: 'claim', status: 'succeeded', verdict: 'verified', changedPaths: ['src/a.ts'] });
    const sheet = await runEvidenceSheet(db, 'org_1', 'loom', 'run_claimed');
    expect(sheet).toMatchObject({ outcome: 'inconclusive', status: 'unknown', raw_outcome: 'verified' });
    expect(sheet?.warnings.join(' ')).toMatch(/downgraded.*acceptance/i);
  });

  it('maps the legacy didnt_work verdict to the explicit failure outcome', async () => {
    await db.insert(agentRuns).values({ id: 'run_legacy', orgId: 'org_1', projectId: 'loom', prompt: 'legacy', status: 'failed', verdict: 'didnt_work' });
    const sheet = await runEvidenceSheet(db, 'org_1', 'loom', 'run_legacy');
    expect(sheet).toMatchObject({ outcome: 'did_not_work', status: 'needs', raw_outcome: 'didnt_work' });
  });
});
