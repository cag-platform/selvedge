import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createSubjectsRouter } from '../../src/server/web/routes/subjects.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { getThread } from '../../src/server/threads/store.js';
import { listSubjects } from '../../src/server/threads/subjects.js';
import { appWithOrg } from '../web/helpers.js';
import { onPlan } from '../helpers/plan.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';

/**
 * FROM AN IDEA TO A THING.
 *
 * The arc this file holds: you start a plain conversation, you think in it
 * with whoever you like, and when it turns out to be real you name a builder
 * and it MOVES — same conversation, same history, now inside a project.
 *
 * The property that makes any of it worth having is the last one. If the
 * conversation restarted, there would be no reason to have had the idea here
 * rather than in a browser tab.
 */
describe('an idea, and what becomes of it', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ daytonaApiKey: 'd' });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await onPlan(db, orgId, 'pro');
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  const subjectsApp = (org = orgId) => appWithOrg(org, createSubjectsRouter(db));
  const threadsApp = (org = orgId, made?: (n: string, d: string) => Promise<{ fullName: string }>) =>
    appWithOrg(org, createThreadsRouter(db, { lookup: stubRepoLookup, env: engineOn, ...(made ? { createRepo: made } : {}) }));

  async function anIdea(): Promise<string> {
    const res = await request(subjectsApp()).post('/api/ideas').send({}).expect(201);
    return res.body.thread.id as string;
  }

  describe('starting one', () => {
    it('is a plain conversation under a subject, not a new kind of thing', async () => {
      const res = await request(subjectsApp()).post('/api/ideas').send({}).expect(201);

      expect(res.body.subject.name).toBe('Ideas');
      expect(res.body.thread.kind).toBe('general');
      // A TALKER, not a builder. Nothing here can build yet, and starting an
      // idea on Claude Code would be offering a sandbox to a sentence.
      expect(res.body.thread.agent).toBe('claude');

      // Filed somewhere, which is the whole reason it is a subject: a thread
      // belonging to neither a project nor a subject appears in no list at all.
      const thread = await getThread(db, orgId, res.body.thread.id);
      expect(thread?.subjectId).toBeTruthy();
      expect(thread?.projectId).toBeNull();
    });

    it('makes the subject once and reuses it forever after', async () => {
      await request(subjectsApp()).post('/api/ideas').send({}).expect(201);
      await request(subjectsApp()).post('/api/ideas').send({}).expect(201);
      const ideas = (await listSubjects(db, orgId)).filter((s) => s.name === 'Ideas');
      expect(ideas).toHaveLength(1);
    });

    it('is org-scoped, so one account never starts an idea in another', async () => {
      await request(subjectsApp()).post('/api/ideas').send({}).expect(201);
      expect((await listSubjects(db, 'org_2')).filter((s) => s.name === 'Ideas')).toHaveLength(0);
    });
  });

  /**
   * THE WALL THAT BECAME A QUESTION.
   *
   * Naming a builder here used to be a flat 409 with nothing to do about it —
   * while the roster had listed that same builder as AVAILABLE and quoted the
   * switch at nothing. Three surfaces disagreeing, and only the last one told
   * the truth.
   */
  describe('naming a builder in one', () => {
    it('refuses with the choices, rather than with a wall', async () => {
      const id = await anIdea();
      const res = await request(threadsApp())
        .post(`/api/threads/${id}/message`)
        .send({ text: '@claudecode ok build it' })
        .expect(409);

      expect(res.body.code).toBe('needs_project');
      expect(res.body.error).toMatch(/builds inside a project/i);
      // The projects it could join, so the answer is available in place.
      expect(res.body.projects).toEqual([{ id: 'loom', name: 'Loom' }]);
      // Nothing was created and nothing ran.
      expect(await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId))).toHaveLength(0);
    });

    it('does not offer to make a repo on a deployment that cannot', async () => {
      const id = await anIdea();
      const res = await request(threadsApp()).post(`/api/threads/${id}/message`).send({ text: '@claudecode build it' }).expect(409);
      expect(res.body.can_create).toBe(false);
    });

    it('the roster says the same thing the message route does', async () => {
      const id = await anIdea();
      const res = await request(threadsApp()).get(`/api/threads/${id}/agents`).expect(200);
      const builders = res.body.agents.filter((a: { changes_files: boolean }) => a.changes_files);

      expect(builders).toHaveLength(2);
      for (const b of builders) {
        // Listed, because hiding it teaches people the product is smaller than
        // it is — and unavailable, because it is.
        expect(b.available).toBe(false);
        expect(b.unavailable_note).toMatch(/builds inside a project/i);
      }
    });
  });

  describe('the move', () => {
    it('carries the whole conversation into an existing project', async () => {
      const id = await anIdea();
      await db.insert(agentMessages).values([
        { id: 'm1', orgId, threadId: id, role: 'owner', content: 'should we scrape the catalogue or ask for a feed?' },
        { id: 'm2', orgId, threadId: id, role: 'agent', content: 'Ask first — three of the mills publish one.' },
      ]);

      const res = await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(201);
      expect(res.body.moved).toBe(true);

      // SAME THREAD. Not a summary, not a fresh start — the argument about
      // scraping is now inside the project it produced.
      const after = await getThread(db, orgId, id);
      expect(after?.projectId).toBe('loom');
      expect(after?.subjectId).toBeNull();
      const kept = await db.select().from(agentMessages).where(eq(agentMessages.threadId, id));
      expect(kept).toHaveLength(2);
      expect(kept.map((m) => m.content)).toContain('Ask first — three of the mills publish one.');
    });

    it('lets the builder answer once it has somewhere to build', async () => {
      const id = await anIdea();
      await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(201);

      const roster = await request(threadsApp()).get(`/api/threads/${id}/agents`).expect(200);
      const cc = roster.body.agents.find((a: { id: string }) => a.id === 'claude-code');
      expect(cc.unavailable_note).not.toMatch(/builds inside a project/i);
    });

    it('makes a project and a repo when asked, and joins that', async () => {
      const id = await anIdea();
      const minted: string[] = [];
      const app = threadsApp(orgId, async (name) => {
        minted.push(name);
        return { fullName: `acme/${name}` };
      });

      const res = await request(app).post(`/api/threads/${id}/build`).send({ create: { name: 'Swatch Watch' } }).expect(201);
      expect(minted).toEqual(['swatch-watch']);
      expect(res.body.created_project).toBe('swatch-watch');
      expect((await getThread(db, orgId, id))?.projectId).toBe('swatch-watch');
    });

    /**
     * THE PLAN GATE FIRES BEFORE GITHUB IS TOUCHED. A limit that bit after the
     * side effect would leave somebody with a repo they don't get to use.
     */
    it('refuses past the project limit without minting anything', async () => {
      await onPlan(db, orgId, 'free');
      const id = await anIdea();
      const minted: string[] = [];
      const app = threadsApp(orgId, async (name) => {
        minted.push(name);
        return { fullName: `acme/${name}` };
      });
      // Free allows 2; `loom` plus one more fills it.
      await createPack(db, orgId, makeTestPack({ identity: { project_id: 'second', name: 'Second', owner_description: 'x' } }));

      const res = await request(app).post(`/api/threads/${id}/build`).send({ create: { name: 'Swatch Watch' } }).expect(402);
      expect(res.body.code).toBe('limit_projects');
      expect(minted).toEqual([]);
      expect((await getThread(db, orgId, id))?.projectId).toBeNull();
    });

    it('says so plainly when the deployment cannot make repos at all', async () => {
      const id = await anIdea();
      const res = await request(threadsApp()).post(`/api/threads/${id}/build`).send({ create: { name: 'Swatch Watch' } }).expect(503);
      expect(res.body.error).toMatch(/can't create repos/i);
    });

    it('needs one destination, not both and not neither', async () => {
      const id = await anIdea();
      await request(threadsApp()).post(`/api/threads/${id}/build`).send({}).expect(400);
      await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom', create: { name: 'x' } }).expect(400);
    });

    it('will not move a conversation that already has a project', async () => {
      const id = await anIdea();
      await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(201);
      const again = await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(200);
      expect(again.body.moved).toBe(false);
    });

    it("will not reach into another org's thread", async () => {
      const id = await anIdea();
      await request(threadsApp('org_2')).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(404);
      expect((await getThread(db, orgId, id))?.projectId).toBeNull();
    });
  });

  /**
   * ONE PLACE. An idea that becomes a project LEAVES the Ideas list — it does
   * not live in both. That is the decision, and the visible consequence is that
   * Ideas empties as things succeed rather than accumulating everything that
   * ever worked.
   */
  it('leaves the idea list when it becomes a project', async () => {
    const id = await anIdea();
    const before = await db.select().from(threads).where(eq(threads.orgId, orgId));
    expect(before.filter((t) => t.subjectId !== null)).toHaveLength(1);

    await request(threadsApp()).post(`/api/threads/${id}/build`).send({ project_id: 'loom' }).expect(201);

    const after = await db.select().from(threads).where(eq(threads.orgId, orgId));
    expect(after.filter((t) => t.subjectId !== null)).toHaveLength(0);
    expect(after.filter((t) => t.projectId === 'loom')).toHaveLength(1);
  });
});
