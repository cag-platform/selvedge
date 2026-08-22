import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { createThread } from '../../src/server/threads/store.js';
import { switchThreadAgent } from '../../src/server/threads/switch.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import type { AgentOffer } from '../../src/server/threads/roster.js';
import { appWithOrg } from './helpers.js';

/**
 * THE PICKER'S PRICE TAG.
 *
 * The handover cost used to arrive on the thread after a switch — you had to
 * commit in order to find out. This endpoint quotes it per candidate, in
 * advance, and the one property worth testing hardest is that the quote and
 * the charge come from the same place: a price tag that turns out to have been
 * a guess is worse than no price tag at all.
 */
describe('who could answer this, and what handing it over would cost', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c', githubToken: 'g', openaiApiKey: 'o' });

  beforeEach(async () => {
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }),
    );
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  const app = (env = engineOn) => appWithOrg(orgId, createThreadsRouter(db, { env }));

  /** A conversation with something in it, so a handover has something to carry. */
  async function conversation() {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Gift notes' });
    await db.insert(agentMessages).values([
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'owner', content: 'per-item or per-order gift notes?' },
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'Per-order — per-item doubles fulfilment for a 5% case.' },
    ]);
    return thread;
  }

  const roster = async (threadId: string, env = engineOn): Promise<AgentOffer[]> =>
    (await request(app(env)).get(`/api/threads/${threadId}/agents`).expect(200)).body.agents;

  it('lists everyone, and says which one is answering', async () => {
    const thread = await conversation();
    const agents = await roster(thread.id);

    expect(agents.map((a) => a.id)).toEqual(['claude-code', 'codex', 'claude', 'gpt']);
    expect(agents.filter((a) => a.answering_now).map((a) => a.id)).toEqual(['claude']);
  });

  /**
   * "Changes files" is the whole of what used to be a thread kind, said in the
   * one place the choice is actually made.
   */
  it('says what each one does rather than what kind of thread it needs', async () => {
    const agents = await roster((await conversation()).id);
    const by = (id: string) => agents.find((a) => a.id === id)!;

    expect(by('claude-code').changes_files).toBe(true);
    expect(by('claude-code').does).toMatch(/changes files/i);
    expect(by('gpt').changes_files).toBe(false);
    expect(by('gpt').does).toMatch(/doesn't touch your files/i);
  });

  it('prices a handover to a builder, and says a handover to a talker is free', async () => {
    const agents = await roster((await conversation()).id);

    const builder = agents.find((a) => a.id === 'claude-code')!;
    expect(builder.handoff!.tokens).toBeGreaterThan(0);
    expect(builder.handoff!.note).toMatch(/switching costs about \$/);
    expect(builder.handoff!.note).toMatch(/carries/);

    const talker = agents.find((a) => a.id === 'gpt')!;
    expect(talker.handoff).toEqual({ tokens: 0, cost_usd: null, note: 'switching is free' });

    // Nobody quotes you a price for staying where you are.
    expect(agents.find((a) => a.answering_now)!.handoff).toBeNull();
  });

  /**
   * THE PROPERTY THAT MATTERS. What the picker promised is what the thread
   * records, to the token — because both come from `quoteHandoff`.
   */
  it('charges exactly what it quoted', async () => {
    const thread = await conversation();
    const quoted = (await roster(thread.id)).find((a) => a.id === 'claude-code')!.handoff!;

    const switched = await switchThreadAgent(db, orgId, thread.id, 'claude-code');
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;

    expect(switched.handoff!.estimated_tokens).toBe(quoted.tokens);

    const [line] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id), eq(agentMessages.role, 'switch')));
    const meta = line!.meta as { switch: { tokens: number; cost_usd: number | null } };
    expect(meta.switch.tokens).toBe(quoted.tokens);
    expect(meta.switch.cost_usd).toBe(quoted.cost_usd);
  });

  /**
   * An agent that can't run today says why, in words, and stays on the list.
   * Hiding it would teach people the product is smaller than it is.
   */
  it('keeps an agent it cannot run, and says what is missing', async () => {
    const thread = await conversation();

    // Claude answers this conversation, and nobody connected an Anthropic key.
    const noKey = (await roster(thread.id)).find((a) => a.id === 'gpt')!;
    expect(noKey.available).toBe(false);
    expect(noKey.unavailable_note).toMatch(/no key connected/i);

    await connectCredential(db, orgId, 'openai', 'sk-oai-test-0002');
    expect((await roster(thread.id)).find((a) => a.id === 'gpt')!.available).toBe(true);
  });

  it('says when the build engine is off, without dropping the builders', async () => {
    const agents = await roster((await conversation()).id, () => null);

    const builders = agents.filter((a) => a.changes_files);
    expect(builders).toHaveLength(2);
    expect(builders.every((a) => !a.available)).toBe(true);
    expect(builders[0]!.unavailable_note).toMatch(/build engine isn't switched on/i);
  });

  it("says Codex needs its own key, which is fuel and not wiring", async () => {
    const agents = await roster((await conversation()).id, () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' }));
    const codex = agents.find((a) => a.id === 'codex')!;

    expect(codex.available).toBe(false);
    expect(codex.unavailable_note).toMatch(/OpenAI key/i);
    // ...while the builder that does have its engine is offered as normal.
    expect(agents.find((a) => a.id === 'claude-code')!.available).toBe(true);
  });

  it('is org-scoped', async () => {
    const thread = await conversation();
    const theirs = appWithOrg('org_2', createThreadsRouter(db, { env: engineOn }));
    await request(theirs).get(`/api/threads/${thread.id}/agents`).expect(404);
  });
});
