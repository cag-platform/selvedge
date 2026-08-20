import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { setBuild } from '../../src/server/build/store.js';
import { createThread, ensureWorkshopThread, getThread } from '../../src/server/threads/store.js';
import { markHandoffSpent, pendingHandoff, switchThreadAgent, switchLine } from '../../src/server/threads/switch.js';

/**
 * SWITCHING BUILDERS MID-TASK — the interaction the Inbox is for.
 *
 * The promise under test is narrow: the incoming agent starts where the last
 * one stopped, the record says what was handed over and what it cost, and a
 * switch that can't help (a chat model asked to build) is refused in words
 * rather than accepted and quietly broken.
 */
describe('switching the agent behind a thread', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
  });
  afterEach(async () => close());

  async function workshopThreadWithHistory() {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1', stagedChangesReady: true });
    await db.insert(agentMessages).values([
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'owner', content: 'the checkout empties itself when you go back' },
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'activity', content: 'Reading src/checkout/Cart.tsx\nEditing src/checkout/Cart.tsx' },
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'I moved the validation into one place.' },
    ]);
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'the checkout empties itself',
      status: 'succeeded',
      costCents: 22,
      changedPaths: ['src/checkout/Cart.tsx'],
    });
    return thread;
  }

  it('hands over the work in progress, and parks the handoff for the next turn', async () => {
    const thread = await workshopThreadWithHistory();
    const out = await switchThreadAgent(db, orgId, thread.id, 'codex');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(true);
    expect(out.thread.agent).toBe('codex');
    expect(out.handoff).not.toBeNull();

    // What the next agent will be started with: the project, the work so far,
    // and the state of the sandbox it is inheriting.
    const payload = out.handoff!.text;
    expect(payload).toContain('Loom');
    expect(payload).toContain('src/checkout/Cart.tsx');
    expect(payload).toMatch(/NOT been shipped yet/);

    const parked = await pendingHandoff(db, orgId, thread.id);
    expect(parked?.text).toBe(payload);
  });

  it('writes the switch on the thread, with the real size of what was handed over', async () => {
    const thread = await workshopThreadWithHistory();
    const out = await switchThreadAgent(db, orgId, thread.id, 'codex');
    if (!out.ok) throw new Error('expected the switch to go through');

    const [line] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'switch')));
    expect(line!.content).toContain('continued with Codex');
    expect(line!.content).toMatch(/handoff .*tokens/);
    // The number said out loud is the payload's measured size, not a round one.
    const meta = line!.meta as { switch: { tokens: number; cost_usd: number | null; from: string; to: string } };
    expect(meta.switch.tokens).toBe(out.handoff!.estimated_tokens);
    expect(meta.switch.from).toBe('claude-code');
    expect(meta.switch.to).toBe('codex');
    // Carrying that context has a price, quoted at the incoming agent's published rate.
    expect(meta.switch.cost_usd).toBeGreaterThan(0);
    expect(line!.content).toMatch(/\$\d/);
  });

  it('the parked handoff is spent once, and only when a turn has taken it', async () => {
    const thread = await workshopThreadWithHistory();
    await switchThreadAgent(db, orgId, thread.id, 'codex');
    const parked = (await pendingHandoff(db, orgId, thread.id))!;

    await markHandoffSpent(db, orgId, parked.messageId);
    expect(await pendingHandoff(db, orgId, thread.id)).toBeNull();

    // The payload itself stays on the record — a handover nobody can read back
    // is a handover nobody can check.
    const [line] = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, parked.messageId)));
    expect((line!.meta as { switch: { payload: string | null } }).switch.payload).toContain('Loom');
  });

  it('a general thread hands nothing over — the history is already there', async () => {
    const chat = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });
    const out = await switchThreadAgent(db, orgId, chat.id, 'gpt');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.handoff).toBeNull();
    expect(out.line).toContain('carries over as it is');
    expect(await pendingHandoff(db, orgId, chat.id)).toBeNull();
    expect((await getThread(db, orgId, chat.id))!.agent).toBe('gpt');
  });

  it('refuses a switch that cannot work, in words, before anything is written', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const out = await switchThreadAgent(db, orgId, thread.id, 'gpt');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('wrong_kind');
    expect(out.message).toMatch(/can't build in a sandbox/i);
    expect((await getThread(db, orgId, thread.id))!.agent).toBe('claude-code');
    const lines = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'switch')));
    expect(lines).toHaveLength(0);
  });

  it('switching to the agent already answering writes nothing at all', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const out = await switchThreadAgent(db, orgId, thread.id, 'claude-code');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(false);
    expect(out.line).toBeNull();
    const lines = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(lines).toHaveLength(0);
  });

  it('is org-scoped, and unknown agents are unknown', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    expect(await switchThreadAgent(db, 'org_2', thread.id, 'codex')).toMatchObject({ ok: false, reason: 'no_such_thread' });
    expect(await switchThreadAgent(db, orgId, thread.id, 'llama')).toMatchObject({ ok: false, reason: 'unknown_agent' });
  });

  it('says the size the way a person would, and never quotes a price it cannot stand behind', () => {
    expect(switchLine('claude-code', 'codex', 1834, 0.0037)).toBe('⇄ continued with Codex — handoff 1.8k tokens, about $0.004');
    expect(switchLine('claude-code', 'codex', 420, null)).toBe('⇄ continued with Codex — handoff 420 tokens — its cost lands with the turn.');
  });
});
