import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentRuns } from '../../src/server/db/schema/index.js';
import { shipChanges, rollbackShip, observeAfterShip, shipReach, shipMessageFor } from '../../src/server/build/ship.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
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

/**
 * Ship used to tell every owner "your host is taking it live now" without ever
 * checking that anything was wired to deploy. For a project nobody connected a
 * host to, that is a false all-clear: the ship succeeds, nothing goes live, and
 * Selvedge says it did.
 */
describe('shipReach — never promise a deploy nobody set up', () => {
  const pack = (over: Parameters<typeof makeTestPack>[0] = {}) => makeTestPack(over);

  it('with a live address, the ship is watched', () => {
    expect(
      shipReach(pack({ identity: { project_id: 'p', name: 'P', owner_description: 'x', links: { live_url: 'https://shop.example' } } })),
    ).toBe('watched');
  });

  it('with a host connected but no address, it is honest about not being able to watch', () => {
    const reach = shipReach(
      pack({ topology: { sources: [{ connector: 'railway', resource_id: 'p/e/s', role: 'production_host' }] } }),
    );
    expect(reach).toBe('host_only');
    expect(shipMessageFor(reach)).toMatch(/can't watch it land/i);
  });

  it('with nothing wired at all, it says plainly that the app is NOT live', () => {
    const reach = shipReach(pack({ topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] } }));
    expect(reach).toBe('pushed_only');
    const line = shipMessageFor(reach);
    expect(line).toMatch(/not live/i);
    expect(line).not.toMatch(/taking it live/i);
  });

  it('a missing pack is treated as nothing wired — never as a deploy', () => {
    expect(shipReach(null)).toBe('pushed_only');
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
    // This project has no host wired, so the thread says pushed — not "live".
    // (The wording per case is covered by the shipReach tests above.)
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(thread[0]!.content).toMatch(/pushed/i);
  });

  it('on a project with no host wired, the thread says plainly that it is NOT live', async () => {
    // No pack exists for 'loom' in this suite — the "nobody wired anything" case.
    const out = await shipChanges(db, orgId, 'loom', cfg, {}, { execute: executor({ paths: ['src/app.tsx'] }) });
    expect(out.outcome).toBe('shipped');
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(msg!.content).toMatch(/not live/i);
    expect(msg!.content).not.toMatch(/taking it live/i);
  });

  it('on a project with a live address, it says it is watching — the old promise, now earned', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'hosted', name: 'Hosted', owner_description: 'x', links: { live_url: 'https://shop.example' } },
      }),
    );
    await setBuild(db, orgId, 'hosted', { sandboxId: 'sbx_2', stagedChangesReady: true, repoFullName: 'acme/hosted' });
    const out = await shipChanges(db, orgId, 'hosted', cfg, {}, { execute: executor({ paths: ['src/app.tsx'] }) });
    expect(out.outcome).toBe('shipped');
    if (out.outcome !== 'shipped') return;
    expect(out.message).toMatch(/watching it land/i);
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

describe('observeAfterShip — the auto-undo, armed on a confirmed break only', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const up = { up: true, latencyMs: 5, detail: null };
  const down = { up: false, latencyMs: 0, detail: 'HTTP 500' };
  const fast = { sleep: async () => {}, windowMs: 120_000, intervalMs: 30_000 };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sbx_1', repoFullName: 'acme/loom' });
  });
  afterEach(async () => close());

  const observe = (probes: Array<typeof up>, rollback: () => Promise<{ ok: boolean; message: string }>) => {
    let i = 0;
    let clock = 0;
    return observeAfterShip(db, 'org_1', 'loom', cfg, 'a1b2c3d', 'https://loom.example', {
      ...fast,
      now: () => (clock += 15_000),
      probe: async () => probes[Math.min(i++, probes.length - 1)]!,
      rollback,
    });
  };

  it('a confirmed break (two failures) auto-reverts and tells the thread plainly', async () => {
    let reverted = false;
    const out = await observe([up, down, down], async () => { reverted = true; return { ok: true, message: 'undone' }; });
    expect(out.outcome).toBe('broke');
    expect(reverted).toBe(true);
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'org_1'));
    expect(thread.at(-1)!.content).toMatch(/broke the live app/i);
    expect(thread.at(-1)!.content).toMatch(/already undone/i);
  });

  it('a single blip never rolls back, and a held window is confirmed out loud', async () => {
    let reverted = false;
    const out = await observe([up, down, up, up], async () => { reverted = true; return { ok: true, message: '' }; });
    expect(out.outcome).toBe('held');
    expect(reverted).toBe(false);
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'org_1'));
    expect(thread.at(-1)!.content).toMatch(/it's standing/i);
  });

  it('never claims "undone" when the auto-revert itself failed', async () => {
    const out = await observe([down, down], async () => ({ ok: false, message: 'CONFLICT — a later change overlaps.' }));
    expect(out.outcome).toBe('broke');
    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'org_1'));
    expect(thread.at(-1)!.content).toMatch(/didn't apply cleanly/i);
    expect(thread.at(-1)!.content).not.toMatch(/already undone/i);
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
