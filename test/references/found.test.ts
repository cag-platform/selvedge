import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { findRelatedConversations } from '../../src/server/references/resolve.js';
import { referenceLine } from '../../src/shared/references.js';

/**
 * Nobody types punctuation when they are thinking. "refer to our chats about
 * moving to a monthly fee" is how the question arrives, and answering it with
 * "no such thing as that" while the conversation sits in the database is the
 * product being pedantic at somebody who is right.
 *
 * The database does the finding, not a model — so the cost is one query
 * whatever the size of the history, rather than a prompt that gets more
 * expensive with every conversation you have.
 */
describe('references/found — reaching back without being told to', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  async function conversation(title: string, said: string[], over: Partial<typeof threads.$inferInsert> = {}) {
    const id = ulid();
    await db.insert(threads).values({ id, orgId, kind: 'general', title, agent: 'claude', projectId: 'loom', ...over });
    for (const content of said) {
      await db.insert(agentMessages).values({ id: ulid(), orgId, threadId: id, role: 'owner', content });
    }
    return id;
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

  it('finds the conversation a plain-English question is about', async () => {
    await conversation('Pricing the platform', [
      'we should stop taking a cut of each order and charge a monthly subscription fee instead',
      'a flat monthly fee is easier for the shops to budget for than per-order commission',
    ]);
    await conversation('Curtain fabric suppliers', ['which mills can do blackout lining at that width?']);

    const found = await findRelatedConversations(db, orgId, 'refer to our chats about the transition from per-order payments to a monthly fee');
    expect(found.map((f) => f.label)).toEqual(['Pricing the platform']);
    expect(found[0]!.found).toBe(true);
    expect(found[0]!.text).toContain('monthly subscription fee');
  });

  it('says it was a guess, not a choice', async () => {
    // Presenting a find as though it had been chosen is how somebody ends up
    // believing they pointed at something they never did.
    const line = referenceLine([{ label: 'Pricing the platform', found: true }]);
    expect(line).toContain('looked back at');
    expect(line).toContain('seemed to be what you meant');

    const both = referenceLine([{ label: 'Loom' }, { label: 'Pricing the platform', found: true }]);
    expect(both).toContain('reading Loom');
    expect(both).toContain('looked back at Pricing the platform');
  });

  /**
   * AND SAYS WHERE IT LOOKED, WHICH IS THE HALF THAT WAS MISSING.
   *
   * Naming only WHAT was found left the reader to infer the scope from the
   * titles — which is exactly how three imported chats about an unrelated shop
   * read as "what you meant" inside a project they had nothing to do with.
   * Leading with the place makes the guess checkable at a glance: if the
   * results look wrong you can see whether the search was wrong or the place
   * was.
   */
  describe('the line names the place it searched', () => {
    it('leads with the place when the answer came from inside it', () => {
      const line = referenceLine([{ label: 'Ring sizing', found: true }], { searched: 'ringrunner', widened: false });
      expect(line).toContain('searched ringrunner and found Ring sizing');
      expect(line).toContain('seemed to be what you meant');
      // Not the unscoped phrasing — that one claims nothing about where.
      expect(line).not.toContain('looked back at');
    });

    it('says so plainly when the place had nothing and everything was searched instead', () => {
      const line = referenceLine([{ label: 'Selling Canvas Apparel', found: true }], { searched: 'ringrunner', widened: true });
      expect(line).toContain('found nothing in ringrunner');
      expect(line).toContain('so searched everything');
      // A WEAKER CLAIM GETS A WEAKER WORD. Finding it where you were standing
      // and finding it somewhere else entirely are not equally good guesses,
      // and the sentence should not pretend they are.
      expect(line).toContain('might be what you meant');
      expect(line).not.toContain('seemed to be what you meant');
    });

    it('claims no place when there was none to claim', () => {
      // A thread filed nowhere searched everywhere and always did. Naming a
      // scope here would be inventing one.
      const line = referenceLine([{ label: 'Pricing the platform', found: true }]);
      expect(line).toContain('looked back at');
      expect(line).not.toMatch(/searched|found nothing in/);
    });

    it('says nothing about searching when the owner pointed at it themselves', () => {
      // An explicit # is not a guess, so there is no scope to report even when
      // the thread has one.
      const line = referenceLine([{ label: 'Loom' }], { searched: 'ringrunner', widened: true });
      expect(line).toBe('⇄ reading Loom — nothing there was changed.');
    });
  });

  it('brings nothing back for a message that is about nothing', async () => {
    await conversation('Pricing the platform', ['charge a monthly subscription fee instead of per order']);
    // The everyday case, and the one that must stay free: short, contextless
    // instructions carry no subject to search for.
    expect(await findRelatedConversations(db, orgId, 'now make it darker')).toEqual([]);
    expect(await findRelatedConversations(db, orgId, 'do it')).toEqual([]);
    expect(await findRelatedConversations(db, orgId, 'yes')).toEqual([]);
  });

  it('brings nothing back when nothing is about that', async () => {
    await conversation('Curtain fabric suppliers', ['which mills can do blackout lining at that width?']);
    expect(await findRelatedConversations(db, orgId, 'what did we decide about kubernetes autoscaling policies')).toEqual([]);
  });

  it('never leaves the org', async () => {
    await createPack(
      db,
      'org_2',
      makeTestPack({
        identity: { project_id: 'ledger', name: 'Ledger', owner_description: "Somebody else's." },
        topology: { sources: [{ connector: 'github', resource_id: 'other/ledger', role: 'source_of_truth' }] },
      }),
    );
    const id = ulid();
    await db.insert(threads).values({ id, orgId: 'org_2', kind: 'general', title: 'Their pricing', agent: 'claude', projectId: 'ledger' });
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId: 'org_2',
      threadId: id,
      role: 'owner',
      content: 'we should charge a monthly subscription fee rather than per order',
    });

    expect(await findRelatedConversations(db, orgId, 'our chats about charging a monthly subscription fee')).toEqual([]);
  });

  it('does not hand a conversation back to itself', async () => {
    const here = await conversation('Pricing the platform', ['charge a monthly subscription fee instead of per order commission']);
    const found = await findRelatedConversations(db, orgId, 'the monthly subscription fee instead of per order commission', {
      excludeThreadId: here,
    });
    expect(found).toEqual([]);
  });

  it('carries the imported mark on anything it finds', async () => {
    await conversation('app ideas', ['a monthly subscription fee would beat per-order commission for these shops'], {
      importedFrom: 'chatgpt',
      importSourceId: 'x1',
    });
    const found = await findRelatedConversations(db, orgId, 'our chats about a monthly subscription fee for the shops');
    expect(found[0]!.note).toBe('imported from ChatGPT');
    expect(found[0]!.text).toContain('not said to Selvedge');
  });

  it('skips a conversation that has been archived', async () => {
    await conversation('Old pricing thinking', ['a monthly subscription fee instead of per order commission'], {
      archivedAt: new Date(),
    });
    expect(await findRelatedConversations(db, orgId, 'our chats about a monthly subscription fee instead of commission')).toEqual([]);
  });

  it('ignores the # part of a message when searching', async () => {
    // A message that names one thing explicitly and describes another should
    // search on the description, not on the name it already resolved.
    await conversation('Pricing the platform', ['charge a monthly subscription fee rather than per-order commission']);
    const found = await findRelatedConversations(db, orgId, '#loom how does the monthly subscription fee idea fit here');
    expect(found.map((f) => f.label)).toEqual(['Pricing the platform']);
  });

  /**
   * THE ONE THAT GOT OUT.
   *
   * Sent in a thread about a chess app: "@claude give me your thoughts on what
   * could make this better as well". It came back having "looked back at" three
   * imported conversations — a venture pitch, a memory-systems chat, and one
   * about cross-border communications — none of which had anything to do with
   * chess or with each other.
   *
   * Two faults met. `@claude` was left in the query, and conversations imported
   * from Claude contain the word "Claude", so naming who should answer searched
   * for everything that agent had ever said. And the rest of the sentence —
   * give, thoughts, make, better, well — is filler that Postgres does not treat
   * as stopwords, so any two of them cleared the old flat bar of two.
   */
  describe('the words in a message that are not about anything', () => {
    beforeEach(async () => {
      // Three conversations with nothing in common but the fact of being
      // conversations, phrased the way an imported chat log reads.
      await conversation('Pitching SILD to Redbud VC', [
        'I think the deck could be better if we make the traction slide first — give me your thoughts',
      ]);
      await conversation('Domain memory systems for industry learning', [
        'what could make this better is a retrieval step, well worth thinking about',
      ]);
      await conversation('Cross-border enterprise communication', [
        'give me your thoughts on what would make this work better as well',
      ]);
    });

    it('finds nothing in a sentence made entirely of filler', async () => {
      const found = await findRelatedConversations(db, orgId, 'give me your thoughts on what could make this better as well');
      expect(found).toEqual([]);
    });

    /**
     * Choosing who answers is ROUTING. An agent's name must never become a
     * search term — least of all one that matches every conversation imported
     * from that agent.
     */
    it('does not search for the agent that was asked', async () => {
      const found = await findRelatedConversations(db, orgId, '@claude give me your thoughts on what could make this better as well');
      expect(found).toEqual([]);

      // The plain-text form of the same instruction, which wears no punctuation.
      expect(await findRelatedConversations(db, orgId, 'ask claude and gpt what they think about this')).toEqual([]);
    });

    /**
     * The proportional bar, from the other side: a real subject still comes
     * back even when it arrives wrapped in the same filler.
     */
    it('still finds a real subject buried in a polite sentence', async () => {
      await conversation('Basket persistence', ['the basket empties itself when you navigate back from checkout']);
      const found = await findRelatedConversations(
        db,
        orgId,
        'give me your thoughts on what could make the basket checkout navigation better',
      );
      expect(found.map((f) => f.label)).toEqual(['Basket persistence']);
    });
  });

  /**
   * THE THREE CONFIDENT ANSWERS TO A QUESTION NOBODY ASKED.
   *
   * A workshop thread belongs to a project and had no scope at all: only
   * subjects narrowed the search. So asking the builder sitting inside an app
   * to get familiar with that app searched the WHOLE account and came back
   * with imported chats about selling apparel and migrating an unrelated repo
   * — under the words "which seemed to be what you meant".
   *
   * A project is the narrowest and most obvious context there is. If the
   * answer is anywhere, it is here.
   */
  describe('a project is a place a question can be asked inside', () => {
    it('searches only that project when scoped, and would have found the others without it', async () => {
      await conversation('Ring sizing and the checkout flow', [
        'the ring sizing guide should open from the checkout flow rather than a separate page',
      ], { projectId: 'ringrunner' });
      // The imported history that used to answer for everything. Same words,
      // different project — which is exactly why the scope has to be the thing
      // that separates them rather than the wording.
      await conversation('Selling Canvas Apparel to refocus on Smith Bespoke', [
        'the apparel checkout flow needs a sizing guide before we can refocus the shop',
      ], { projectId: 'canvas', importedFrom: 'claude' });

      const question = 'have a look at the checkout flow and the sizing guide in here';

      const scoped = await findRelatedConversations(db, orgId, question, { projectId: 'ringrunner' });
      expect(scoped.map((r) => r.label)).toEqual(['Ring sizing and the checkout flow']);

      // Without the scope the imported conversation comes back too — the exact
      // behaviour the screenshot caught, kept here so the fix cannot silently
      // become a no-op.
      const unscoped = await findRelatedConversations(db, orgId, question);
      expect(unscoped.length).toBeGreaterThan(scoped.length);
      expect(unscoped.map((r) => r.label)).toContain('Selling Canvas Apparel to refocus on Smith Bespoke');
    });

    it('finds nothing rather than something else when the project has nothing to say', async () => {
      await conversation('Selling Canvas Apparel to refocus on Smith Bespoke', [
        'the apparel checkout flow needs a sizing guide before we can refocus the shop',
      ], { projectId: 'canvas', importedFrom: 'claude' });

      const found = await findRelatedConversations(db, orgId, 'have a look at the checkout flow and the sizing guide in here', {
        projectId: 'ringrunner',
      });
      expect(found).toEqual([]);
    });

    it('never reaches into another org, scoped or not', async () => {
      const id = ulid();
      await db.insert(threads).values({ id, orgId: 'org_2', kind: 'general', title: 'Theirs', agent: 'claude', projectId: 'ringrunner' });
      await db.insert(agentMessages).values({
        id: ulid(), orgId: 'org_2', threadId: id, role: 'owner',
        content: 'the ring sizing guide should open from the checkout flow rather than a separate page',
      });

      const found = await findRelatedConversations(db, orgId, 'have a look at the checkout flow and the sizing guide in here', {
        projectId: 'ringrunner',
      });
      expect(found).toEqual([]);
    });
  });
});
