import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentRuns } from '../../src/server/db/schema/index.js';
import { shipChanges, rollbackShip } from '../../src/server/build/ship.js';
import { setBuild, getBuild } from '../../src/server/build/store.js';
import type { ExecuteInSandbox } from '../../src/server/build/agent.js';
import { pathSignals } from '../../src/server/cards/triggers.js';
import { classifyRisk } from '../../src/server/cards/risk.js';

const cfg = { claudeCodeOauthToken: 't', githubToken: 'g', repoFullName: 'acme/loom', branch: 'main' };

/** Scripted executor: diff listing → scripted paths; push chain → scripted result. */
function executor(opts: { paths: string[]; pushExit?: number; sha?: string; onCommand?: (c: string) => void }): ExecuteInSandbox {
  return async (command: string) => {
    opts.onCommand?.(command);
    if (command.includes('--name-only')) return { exitCode: 0, result: opts.paths.join('\n') };
    if (command.includes('git push')) return { exitCode: opts.pushExit ?? 0, result: `pushed\n${opts.sha ?? 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'}` };
    return { exitCode: 0, result: '' };
  };
}

describe('pathSignals — the gate judges the actual diff', () => {
  it('a checkout file is sensitive, whatever the ask was', () => {
    expect(classifyRisk(pathSignals(['src/checkout/Cart.tsx']))).toBe('sensitive');
    expect(classifyRisk(pathSignals(['src/auth/login.ts']))).toBe('sensitive');
  });
  it('a pure styling change is cosmetic', () => {
    expect(classifyRisk(pathSignals(['src/styles/theme.css', 'assets/logo.svg']))).toBe('cosmetic');
  });
  it('ordinary code is ordinary; an empty diff claims nothing', () => {
    expect(classifyRisk(pathSignals(['src/app.tsx']))).toBe('ordinary');
    expect(classifyRisk(pathSignals([]))).toBe('ordinary');
  });
});

describe('shipChanges — build freely, gate at ship', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1', stagedChangesReady: true, repoFullName: 'acme/loom' });
  });
  afterEach(async () => close());

  it('ships an ordinary change: commit + push, run recorded with the sha, staged flag cleared, thread told', async () => {
    const commands: string[] = [];
    const out = await shipChanges(db, orgId, 'loom', cfg, { summary: 'dark header' }, { execute: executor({ paths: ['src/app.tsx'], onCommand: (c) => commands.push(c) }) });
    expect(out.outcome).toBe('shipped');
    if (out.outcome !== 'shipped') return;
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(commands.some((c) => c.includes('git push origin'))).toBe(true);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.prompt).toBe('ship: dark header');
    expect(run!.commitSha).toBe(out.commit);
    expect((await getBuild(db, orgId, 'loom'))?.stagedChangesReady).toBe(false);
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(thread[0]!.content).toMatch(/shipped/i);
  });

  it('a sensitive diff cannot ship without a confirmed backup — and nothing is pushed', async () => {
    const commands: string[] = [];
    const out = await shipChanges(db, orgId, 'loom', cfg, {}, { execute: executor({ paths: ['src/checkout/Cart.tsx'], onCommand: (c) => commands.push(c) }) });
    expect(out.outcome).toBe('backup_required');
    expect(commands.some((c) => c.includes('git push'))).toBe(false);
    expect((await getBuild(db, orgId, 'loom'))?.stagedChangesReady).toBe(true); // still waiting
  });

  it('the same sensitive diff ships once the backup is confirmed', async () => {
    const out = await shipChanges(db, orgId, 'loom', cfg, { backupConfirmed: true }, { execute: executor({ paths: ['src/checkout/Cart.tsx'] }) });
    expect(out.outcome).toBe('shipped');
  });

  it('nothing staged is a plain answer, not a failure', async () => {
    await setBuild(db, orgId, 'loom', { stagedChangesReady: false });
    const out = await shipChanges(db, orgId, 'loom', cfg, {}, { execute: executor({ paths: [] }) });
    expect(out.outcome).toBe('nothing_to_ship');
  });

  it('a failed push is honest and leaves the staged flag alone', async () => {
    const out = await shipChanges(db, orgId, 'loom', cfg, {}, { execute: executor({ paths: ['src/app.tsx'], pushExit: 1 }) });
    expect(out.outcome).toBe('failed');
    expect((await getBuild(db, orgId, 'loom'))?.stagedChangesReady).toBe(true);
  });
});

describe('rollbackShip — a real revert, never a force-push', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sbx_1', repoFullName: 'acme/loom' });
  });
  afterEach(async () => close());

  it('reverts the exact commit and tells the thread', async () => {
    const commands: string[] = [];
    const out = await rollbackShip(db, 'org_1', 'loom', cfg, 'a1b2c3d', { execute: async (c) => { commands.push(c); return { exitCode: 0, result: '' }; } });
    expect(out.ok).toBe(true);
    expect(commands[0]).toContain("git revert --no-edit 'a1b2c3d'");
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'org_1'));
    expect(thread[0]!.content).toMatch(/undone|reverted/i);
  });

  it('refuses a nonsense commit id and is honest about a conflicted revert', async () => {
    expect((await rollbackShip(db, 'org_1', 'loom', cfg, 'not-a-sha', {})).ok).toBe(false);
    const out = await rollbackShip(db, 'org_1', 'loom', cfg, 'abcdef1', { execute: async () => ({ exitCode: 1, result: 'CONFLICT' }) });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/history is untouched/i);
  });
});
