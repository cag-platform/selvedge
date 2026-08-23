import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, threads, agentMessages } from '../../src/server/db/schema/index.js';
import { ensureSubject } from '../../src/server/threads/subjects.js';
import { resolveReferences, findRelatedConversations } from '../../src/server/references/resolve.js';

/**
 * ASKING A SUBJECT SOMETHING.
 *
 * A subject is where the conversations that are not about a codebase live —
 * for an imported history, that is nearly all of them. Naming one used to
 * return five thread TITLES and none of their contents, which made the single
 * gesture meaning "ask my whole imported history" the weakest thing in the
 * product: three hundred and sixty conversations, and pointing at them got you
 * a list of five names.
 *
 * What this file holds is that naming a subject SEARCHES it, and that the
 * answer is never allowed to imply it read more than it did.
 */
describe('a subject is something you can question', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  let subjectId: string;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    subjectId = (await ensureSubject(db, orgId, 'Claude history')).id;
  });
  afterEach(async () => close());

  async function chat(title: string, said: string[], into = subjectId): Promise<string> {
    const id = ulid();
    await db.insert(threads).values({
      id,
      orgId,
      projectId: null,
      subjectId: into,
      kind: 'general',
      title,
      agent: 'claude',
      importedFrom: 'claude',
      importSourceId: id,
    });
    for (const content of said) {
      await db.insert(agentMessages).values({ id: ulid(), orgId, threadId: id, role: 'owner', content });
    }
    return id;
  }

  it('reads what was said in the conversations that match, not a list of names', async () => {
    await chat('Pricing the winter line', ['should the made-to-measure jackets be priced at cost plus forty percent, or a flat markup']);
    await chat('Omnipod basal limits', ['what is the maximum basal rate the pump will take']);

    const { resolved } = await resolveReferences(db, orgId, '#"Claude history" what did I decide about the jacket markup pricing?');
    expect(resolved).toHaveLength(1);
    const subject = resolved[0]!;
    expect(subject.kind).toBe('subject');
    // The words, not the title.
    expect(subject.text).toContain('cost plus forty');
    // And nothing from the conversation that was about something else.
    expect(subject.text).not.toContain('basal rate');
  });

  /**
   * THE COUNT IS THE HONESTY. "Here is your history" from six matches out of
   * three hundred is the same lie as a silent truncation with the volume down.
   */
  it('says how many it searched and how many matched, and forbids speaking for the rest', async () => {
    await chat('Pricing the winter line', ['the jackets are priced at cost plus forty percent — a flat markup was the other option']);
    for (let i = 0; i < 5; i += 1) await chat(`Unrelated ${i}`, ['something else entirely about gardening']);

    const { resolved } = await resolveReferences(db, orgId, '#"Claude history" the jacket markup pricing decision?');
    const text = resolved[0]!.text;
    expect(text).toMatch(/6 conversations are filed under it/);
    expect(text).toMatch(/All 6 were searched/);
    expect(text).toMatch(/may claim to speak for them/);
  });

  /**
   * NOTHING MATCHED IS AN ANSWER, and the titles come back only as evidence
   * for saying so — never as a substitute for having looked.
   */
  it('says it looked and found nothing, rather than answering from the titles', async () => {
    await chat('Omnipod basal limits', ['what is the maximum basal rate the pump will take']);

    const { resolved } = await resolveReferences(db, orgId, '#"Claude history" what did we settle on for warehouse logistics?');
    const text = resolved[0]!.text;
    expect(text).toMatch(/none of them matched/i);
    expect(text).toMatch(/Say that plainly rather than answering from the titles/);
  });

  it('has something honest to say about a subject with nothing in it', async () => {
    await ensureSubject(db, orgId, 'Empty drawer');
    const { resolved } = await resolveReferences(db, orgId, '#"Empty drawer" anything in here about pricing?');
    expect(resolved[0]!.text).toContain('Nothing has been filed under it yet.');
  });

  /** A scoped search must not reach outside the subject it was given. */
  it('searches only inside the subject it was pointed at', async () => {
    const other = await ensureSubject(db, orgId, 'Other drawer');
    await chat('Elsewhere', ['the jackets are priced at cost plus forty, a flat markup was rejected'], other.id);

    const found = await findRelatedConversations(db, orgId, 'what about the jacket markup pricing', { subjectId });
    expect(found).toEqual([]);

    const inOther = await findRelatedConversations(db, orgId, 'what about the jacket markup pricing', { subjectId: other.id });
    expect(inOther).toHaveLength(1);
  });

  it("never reaches into another org's subject", async () => {
    await chat('Pricing the winter line', ['the jackets are priced at cost plus forty, a flat markup was rejected']);
    const found = await findRelatedConversations(db, 'org_2', 'the jacket markup pricing', { subjectId });
    expect(found).toEqual([]);
  });

  /**
   * The conversations it brings back are still marked as imported. Filing a
   * chat under a subject and quoting it into an answer must not launder what
   * was said to ChatGPT into something decided here.
   */
  it('keeps the imported mark on everything it quotes', async () => {
    await chat('Pricing the winter line', ['the jackets are priced at cost plus forty percent — a flat markup was the other option']);
    const { resolved } = await resolveReferences(db, orgId, '#"Claude history" the jacket markup pricing?');
    expect(resolved[0]!.text).toMatch(/not said to Selvedge/);
  });
});
