import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { createThread, createSubjectThread } from '../../src/server/threads/store.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { switchThreadAgent } from '../../src/server/threads/switch.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import type { AgentOffer } from '../../src/server/threads/roster.js';
import { AGENTS } from '../../src/shared/agents.js';
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
  const engineOn = () => ({ daytonaApiKey: 'd' });

  // EVERY builder's fuel resolves the same way now — the org's own account
  // first, the deployment's second — so the deployment's has to be absent for
  // "nothing connected" to mean what it says here. Claude Code joined this
  // list when its token stopped coming free with the deployment.
  const platformOpenAi = process.env.OPENAI_API_KEY;
  const platformClaude = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(async () => {
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
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
    if (platformOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = platformOpenAi;
    if (platformClaude === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = platformClaude;
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

    // Everyone in the registry, in registry order — the roster hides nothing,
    // which is the property worth pinning rather than the current headcount.
    expect(agents.map((a) => a.id)).toEqual(AGENTS.map((a) => a.id));
    expect(agents.filter((a) => a.answering_now).map((a) => a.id)).toEqual(['claude']);
    // And the newer talkers are listed even with no key connected, each with a
    // sentence rather than a silence.
    const grok = agents.find((a) => a.id === 'grok')!;
    expect(grok.available).toBe(false);
    expect(grok.unavailable_note).toMatch(/Connections/);
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
    // The KIND of no travels with it: a missing key is Connections' problem,
    // which is what lets the picker hide the row without losing the truth.
    expect(noKey.blocked_by).toBe('org');

    await connectCredential(db, orgId, 'openai', 'sk-oai-test-0002');
    const keyed = (await roster(thread.id)).find((a) => a.id === 'gpt')!;
    expect(keyed.available).toBe(true);
    expect(keyed.blocked_by).toBeNull();
  });

  it('marks a builder with no project as the thread\'s problem, not the org\'s', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0009', { kind: 'api_key' });
    // A thread with no project: the builder's account is connected, the
    // engine is on, and the only missing thing is somewhere to put the code.
    const subject = await createSubject(db, orgId, 'Ideas');
    const bare = await createSubjectThread(db, orgId, subject.id, { title: 'an idea' });
    const row = (await roster(bare.id)).find((a) => a.id === 'claude-code')!;
    expect(row.available).toBe(false);
    expect(row.blocked_by).toBe('thread');
    expect(row.unavailable_note).toMatch(/builds inside a project/i);
  });

  it('says when the build engine is off, without dropping the builders', async () => {
    const agents = await roster((await conversation()).id, () => null);

    const builders = agents.filter((a) => a.changes_files);
    expect(builders).toHaveLength(2);
    expect(builders.every((a) => !a.available)).toBe(true);
    expect(builders[0]!.unavailable_note).toMatch(/build engine isn't switched on/i);
  });

  /**
   * FUEL IS NOT WIRING, AND IT IS NOW EVERY BUILDER'S QUESTION.
   *
   * This test used to assert that Claude Code was available on the strength of
   * the engine alone, because its token came out of the deployment's
   * environment — which was the bug: one account's subscription running every
   * customer's builds. Both builders are asked the same question now, and both
   * answer it with the org's own account.
   */
  it('says each builder needs its own account, which is fuel and not wiring', async () => {
    const agents = await roster((await conversation()).id);

    for (const id of ['codex', 'claude-code']) {
      const row = agents.find((a) => a.id === id)!;
      expect(row.available).toBe(false);
      expect(row.unavailable_note).toMatch(/Connections/);
    }
    expect(agents.find((a) => a.id === 'codex')!.unavailable_note).toMatch(/OpenAI/i);
    expect(agents.find((a) => a.id === 'claude-code')!.unavailable_note).toMatch(/Anthropic/i);
  });

  it('offers a builder as soon as its own account is connected', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0002', { kind: 'api_key' });
    const agents = await roster((await conversation()).id);
    expect(agents.find((a) => a.id === 'claude-code')!.available).toBe(true);
    // ...and connecting one builder's account says nothing about the other's.
    expect(agents.find((a) => a.id === 'codex')!.available).toBe(false);
  });

  it('is org-scoped', async () => {
    const thread = await conversation();
    const theirs = appWithOrg('org_2', createThreadsRouter(db, { env: engineOn }));
    await request(theirs).get(`/api/threads/${thread.id}/agents`).expect(404);
  });
});
