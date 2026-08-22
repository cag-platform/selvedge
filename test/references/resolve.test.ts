import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { createThread, createSubjectThread, ensureWorkshopThread } from '../../src/server/threads/store.js';
import { resolveReferences, renderReferences } from '../../src/server/references/resolve.js';

/**
 * A reference pulls one of the owner's conversations into another one. Which
 * makes this the exact wrong place to be relaxed about whose data it is, or
 * about where something was said.
 */
describe('references/resolve — reading one conversation inside another', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  async function say(threadId: string, role: 'owner' | 'agent', content: string) {
    await db.insert(agentMessages).values({ id: ulid(), orgId, threadId, role, content });
  }

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'The curtain shop storefront.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => {
    await close();
  });

  it('resolves a project to what actually happened to it', async () => {
    const { resolved, missed } = await resolveReferences(db, orgId, 'how does #loom handle refunds?');
    expect(missed).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.kind).toBe('project');
    expect(resolved[0]!.label).toBe('Loom');
    expect(resolved[0]!.text).toContain('The curtain shop storefront');
  });

  it('resolves a conversation to its own turns', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing thinking' });
    await say(thread.id, 'owner', 'should we charge per seat or per site?');
    await say(thread.id, 'agent', 'Per site. Per seat punishes the shops with staff, who are the ones paying you.');

    const { resolved } = await resolveReferences(db, orgId, 'what did we land on in #"Pricing thinking"?');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.kind).toBe('conversation');
    expect(resolved[0]!.text).toContain('Per site');
    expect(resolved[0]!.text).toContain('Owner: should we charge');
  });

  it('says an imported chat is imported, every single time it is used', async () => {
    // The rule this test exists for: what you told ChatGPT in March is worth
    // knowing and is NOT the same as something decided here. A reference that
    // quietly turns the first into the second is the false-calm rule wearing a
    // different coat.
    const id = ulid();
    await db.insert(threads).values({
      id,
      orgId,
      kind: 'general',
      title: 'diabetes app ideas',
      agent: 'claude',
      projectId: 'loom',
      importedFrom: 'chatgpt',
      importSourceId: 'abc-123',
    });
    await say(id, 'owner', 'what would make a diabetes app actually useful?');

    const { resolved } = await resolveReferences(db, orgId, 'building on #"diabetes app ideas"');
    expect(resolved[0]!.note).toBe('imported from ChatGPT');
    expect(resolved[0]!.text).toContain('imported from ChatGPT');
    expect(resolved[0]!.text).toContain('not said to Selvedge');
    // And it survives into what the model actually reads.
    expect(renderReferences({ resolved, missed: [] })).toContain('imported from ChatGPT');
  });

  it('resolves a subject to what is filed under it', async () => {
    const subject = await createSubject(db, orgId, 'Taxes');
    await createSubjectThread(db, orgId, subject.id, { title: 'VAT registration' });
    const { resolved } = await resolveReferences(db, orgId, 'anything in #Taxes about this?');
    expect(resolved[0]!.kind).toBe('subject');
    expect(resolved[0]!.text).toContain('VAT registration');
  });

  it('never reaches another org', async () => {
    await createPack(
      db,
      'org_2',
      makeTestPack({
        identity: { project_id: 'ledger', name: 'Ledger', owner_description: "Somebody else's books." },
        topology: { sources: [{ connector: 'github', resource_id: 'other/ledger', role: 'source_of_truth' }] },
      }),
    );
    const { resolved, missed } = await resolveReferences(db, orgId, 'compare with #Ledger');
    expect(resolved).toEqual([]);
    expect(missed).toEqual([{ name: 'Ledger' }]);
  });

  it('reports a name that means nothing rather than dropping it', async () => {
    // An answer that silently ignores half of what was asked about is worse
    // than one that says it has nothing by that name.
    const result = await resolveReferences(db, orgId, 'what about #nonesuch?');
    expect(result.resolved).toEqual([]);
    const rendered = renderReferences(result);
    expect(rendered).toContain('nonesuch');
    expect(rendered).toContain('nothing in this account');
  });

  it('forgives punctuation and case without guessing', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'peas-bees', name: 'Peas&Bees Co', owner_description: 'The garden shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/peas', role: 'source_of_truth' }] },
      }),
    );
    expect((await resolveReferences(db, orgId, '#peasbees')).resolved[0]?.label).toBe('Peas&Bees Co');
    expect((await resolveReferences(db, orgId, '#PEAS')).resolved[0]?.label).toBe('Peas&Bees Co');
    // Prefix, not substring: a loose search here would quietly hand over the
    // wrong project, which is the one failure mode worse than finding nothing.
    expect((await resolveReferences(db, orgId, '#bees')).resolved).toEqual([]);
  });

  it('prefers the project when a project and its thread share a name', async () => {
    await ensureWorkshopThread(db, orgId, 'loom');
    const { resolved } = await resolveReferences(db, orgId, '#loom');
    expect(resolved[0]!.kind).toBe('project');
  });

  it('says plainly that nothing here is being asked to change', async () => {
    const result = await resolveReferences(db, orgId, 'like #loom');
    expect(renderReferences(result)).toContain('None of this is what they are asking you to change');
  });

  it('is nothing at all when nothing was referenced', async () => {
    const result = await resolveReferences(db, orgId, 'just a plain question');
    expect(result).toEqual({ resolved: [], missed: [] });
    expect(renderReferences(result)).toBeNull();
  });
});
