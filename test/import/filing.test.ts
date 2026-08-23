import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, packs, threads, agentMessages } from '../../src/server/db/schema/index.js';
import { scaffoldPack } from '../../src/server/packs/scaffold.js';
import { reviewFiling } from '../../src/server/import/filing.js';
import { fileThread, getThread } from '../../src/server/threads/store.js';
import { ensureSubject } from '../../src/server/threads/subjects.js';

/**
 * WHERE AN OLD CONVERSATION BELONGS.
 *
 * Every case in this file came out of running the suggester over a REAL
 * imported history — 407 Claude conversations, twenty-nine projects — and
 * reading what it produced. The first version was confidently wrong in a way I
 * would not have predicted from the code, and the tests are the record of what
 * it got wrong.
 *
 * The rule the whole file defends: a suggestion is evidence shown to a person,
 * not a decision made for them. Nothing here files anything.
 */
describe('which project an imported conversation is about', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  async function project(projectId: string, name: string, repo = `acme/${projectId}`) {
    const pack = scaffoldPack({ name, repo, tier: 'personal' });
    pack.identity.project_id = projectId;
    pack.identity.name = name;
    await db.insert(packs).values({ orgId, projectId, pack });
  }

  async function imported(title: string, opening = ''): Promise<string> {
    const id = ulid();
    await db.insert(threads).values({
      id,
      orgId,
      projectId: null,
      kind: 'general',
      title,
      agent: 'claude',
      importedFrom: 'claude',
      importSourceId: id,
    });
    if (opening) {
      await db.insert(agentMessages).values({ id: ulid(), orgId, threadId: id, role: 'owner', content: opening });
    }
    return id;
  }

  const forTitle = (review: Awaited<ReturnType<typeof reviewFiling>>, title: string) =>
    review.suggestions.find((s) => s.title === title);

  it('matches a multi-word project name wherever it appears', async () => {
    await project('smith-bespoke', 'smith-bespoke');
    await imported('Smith Bespoke debt schedule');
    await imported('Comprehensive financial overview', 'the smith bespoke numbers for this quarter');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toHaveLength(2);
    expect(forTitle(review, 'Smith Bespoke debt schedule')?.projectId).toBe('smith-bespoke');
    expect(forTitle(review, 'Smith Bespoke debt schedule')?.matchedIn).toBe('title');
    // Found in the body, and says so — a weaker claim, shown as one.
    expect(forTitle(review, 'Comprehensive financial overview')?.matchedIn).toBe('text');
  });

  /**
   * THE ONE THAT WAS WRONG.
   *
   * A project called `balance` and a history full of money. The first version
   * of this matched on rarity alone — `balance` appeared in eleven of four
   * hundred conversations, which read as distinctive — and suggested filing
   * "Tesla lease early termination cost" and "Interest calculation on $995
   * loan" into a software project. Every one of those is the ordinary English
   * word, used ordinarily.
   */
  it('does not file an ordinary word used ordinarily', async () => {
    await project('balance', 'balance');
    await imported('Tesla lease early termination cost', 'what would the payoff balance be if I ended it early');
    await imported('Interest calculation on a loan', 'the outstanding balance is about $995');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
  });

  it('does match the same word when a person put it in the title', async () => {
    await project('balance', 'balance');
    await imported('Balance onboarding flow');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0]!.projectId).toBe('balance');
  });

  /**
   * A project named after this product's own core noun. `thread` is in the
   * title of a great many conversations and is evidence of nothing.
   */
  it('ignores a one-word name that is everywhere in this account', async () => {
    await project('thread', 'thread');
    for (let i = 0; i < 12; i += 1) await imported(`Thread pool sizing question ${i}`);

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
    // And the pile is still reported in full — nothing was hidden by being unmatched.
    expect(review.unfiled).toBe(12);
  });

  /**
   * TWO PROJECTS, ONE CONVERSATION. This account really has `loom` and
   * `cag-platform-loom`, and four projects about Smith Bespoke. Picking one to
   * look useful is how a filing tool stops being trusted with filing.
   */
  it('suggests nothing when two projects fit equally, and says how often that happened', async () => {
    await project('sild', 'SILD');
    await project('yoke', 'Yoke');
    await imported('Integrating SILD messaging into Yoke');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
    expect(review.ambiguous).toBe(1);
  });

  it('prefers the longer name when one contains the other', async () => {
    await project('smith-bespoke', 'smith-bespoke');
    await project('bespoke-smith-suite', 'bespoke-smith-suite');
    await imported('Bespoke Smith Suite rollout plan');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0]!.projectId).toBe('bespoke-smith-suite');
  });

  /** A repo owner is shared by every project, so it is evidence for none of them. */
  it('never matches on the shared half of a repo name', async () => {
    await project('drape', 'drape', 'cag-platform/drape');
    await project('patina', 'patina', 'cag-platform/patina');
    await imported('Notes on the cag-platform org setup');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
  });

  /** `sild` inside "consolidated" is not a mention of SILD. */
  it('matches whole words only', async () => {
    await project('sild', 'SILD');
    await imported('Consilidated reporting notes');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
  });

  it('carries the words it matched on, so a person can judge it', async () => {
    await project('smith-bespoke', 'smith-bespoke');
    await imported('Smith Bespoke website redesign');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions[0]!.because).toContain('smith bespoke');
  });

  it('leaves a conversation already filed into a project alone', async () => {
    await project('smith-bespoke', 'smith-bespoke');
    const id = await imported('Smith Bespoke debt schedule');
    await fileThread(db, orgId, id, { projectId: 'smith-bespoke' });

    const review = await reviewFiling(db, orgId);
    expect(review.unfiled).toBe(0);
    expect(review.suggestions).toEqual([]);
  });

  /**
   * MOST OF A HISTORY IS NOT ABOUT A CODEBASE. Of a real 407-conversation
   * import, forty-three named a project. The rest are homeschool programs,
   * insulin pump settings and bank transfers — and a tool that tried to file
   * those into software projects would be inventing work rather than saving it.
   */
  it('says nothing about a conversation that names no project', async () => {
    await project('smith-bespoke', 'smith-bespoke');
    await imported('Omnipod maximum basal rate limits', 'what is the highest basal rate the pump takes');
    await imported('Secular homeschool programs');

    const review = await reviewFiling(db, orgId);
    expect(review.suggestions).toEqual([]);
    expect(review.unfiled).toBe(2);
  });
});

/**
 * THE MOVE ITSELF — the operation the product did not have, which is why an
 * import was a dead end.
 */
describe('filing a conversation somewhere', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    const pack = scaffoldPack({ name: 'loom', repo: 'acme/loom', tier: 'personal' });
    pack.identity.project_id = 'loom';
    await db.insert(packs).values({ orgId, projectId: 'loom', pack });
  });
  afterEach(async () => close());

  async function old(): Promise<string> {
    const id = ulid();
    const subject = await ensureSubject(db, orgId, 'Claude history');
    await db.insert(threads).values({
      id,
      orgId,
      projectId: null,
      subjectId: subject.id,
      kind: 'general',
      title: 'Loom fabric system',
      agent: 'claude',
      importedFrom: 'claude',
      importSourceId: id,
    });
    return id;
  }

  it('moves a conversation into a project and out of its subject', async () => {
    const id = await old();
    expect(await fileThread(db, orgId, id, { projectId: 'loom' })).toBe(true);

    const after = await getThread(db, orgId, id);
    expect(after?.projectId).toBe('loom');
    // One place, not two — otherwise it lists twice in the rail.
    expect(after?.subjectId).toBeNull();
  });

  /**
   * THE PROMISE THAT SURVIVES FILING. An imported conversation carries a mark
   * saying nothing in it was said to Selvedge. Putting it somewhere useful
   * must not launder it into something that was.
   */
  it('never loses where the conversation came from', async () => {
    const id = await old();
    await fileThread(db, orgId, id, { projectId: 'loom' });

    const after = await getThread(db, orgId, id);
    expect(after?.importedFrom).toBe('claude');
    expect(after?.importSourceId).toBe(id);
  });

  it('takes it back out again, to a subject rather than to nowhere', async () => {
    const id = await old();
    await fileThread(db, orgId, id, { projectId: 'loom' });
    const home = await ensureSubject(db, orgId, 'Claude history');

    expect(await fileThread(db, orgId, id, { subjectId: home.id })).toBe(true);
    const after = await getThread(db, orgId, id);
    expect(after?.projectId).toBeNull();
    expect(after?.subjectId).toBe(home.id);
  });

  it("will not move another org's conversation", async () => {
    const id = await old();
    expect(await fileThread(db, 'org_2', id, { projectId: 'loom' })).toBe(false);
    expect((await getThread(db, orgId, id))?.projectId).toBeNull();
  });
});
