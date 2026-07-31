import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrationLibrary } from '../../src/server/db/schema/index.js';
import { DbNarrationLibrary } from '../../src/server/narration/library.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarratableEvent } from '../../src/server/narration/types.js';

function ev(overrides: Partial<NarratableEvent> = {}): NarratableEvent {
  return {
    id: 'evt_1',
    org_id: 'org_a',
    event_type: 'build.succeeded',
    occurred_at: '2026-07-19T10:00:00Z',
    severity_hint: 'info',
    signature: 'Deploy to Railway',
    ...overrides,
  };
}

describe('narration/library — DbNarrationLibrary', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let library: DbNarrationLibrary;

  const pack = makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
    stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
  });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_a' }, { orgId: 'org_b' }]);
    library = new DbNarrationLibrary(db);
  });
  afterEach(async () => close());

  /** Age every candidate past MIN_EXPOSURE_MS so the time gate isn't the thing under test. */
  async function ageEntries(days = 8): Promise<void> {
    await db
      .update(narrationLibrary)
      .set({ createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) });
  }

  it('a burst inside ONE org never graduates, however many uses', async () => {
    // The v1 defect: five emissions in one afternoon — the same flaky build
    // failing repeatedly — promoted a phrasing globally for every tenant,
    // with nobody having affirmed it. Silence is not consent.
    const output = { fragment: 'Loom: your update went live cleanly.' };
    for (let i = 0; i < 12; i++) {
      await library.writeCandidate('org_a', ev(), pack, output);
      expect(await library.lookup('org_a', ev(), pack)).toBeNull();
    }
    await ageEntries();
    expect(await library.lookup('org_a', ev(), pack)).toBeNull();
  });

  it('does not graduate on breadth alone until it has had a week of exposure', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);
    // Two orgs and three uses, but minutes old — a same-day burst.
    expect(await library.lookup('org_b', ev({ org_id: 'org_b' }), pack)).toBeNull();
  });

  it('graduates on 3 uses across two orgs once the exposure window has passed', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    expect(await library.lookup('org_a', ev(), pack)).toBeNull();
    await ageEntries();
    // The use that crosses the breadth threshold, now that time has passed too.
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);
    expect(await library.lookup('org_b', ev({ org_id: 'org_b' }), pack)).not.toBeNull();
  });

  it('serves a graduated phrasing across projects via the {project} slot', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    await ageEntries();
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);

    const mirrorPack = makeTestPack({
      identity: { project_id: 'mirror', name: 'Mirror', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'a/mirror', role: 'source_of_truth' }] },
    });
    const hit = await library.lookup('org_a', ev(), mirrorPack);
    expect(hit?.output.fragment).toBe('Mirror: your update went live cleanly.');
  });

  it('different signatures file under different fingerprints', async () => {
    const output = { fragment: 'Loom: shipped.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    await ageEntries();
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);

    expect(await library.lookup('org_a', ev({ signature: 'Completely Different Workflow' }), pack)).toBeNull();
  });

  it('retireByFingerprint sends a graduated entry back to the LLM path and bumps negative feedback', async () => {
    const output = { fragment: 'Loom: shipped.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    await ageEntries();
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);
    const fingerprint = library.fingerprint(ev(), pack);

    expect(await library.retireByFingerprint(fingerprint)).toBe(true);
    expect(await library.lookup('org_a', ev(), pack)).toBeNull();

    const [row] = await db.select().from(narrationLibrary).where(eq(narrationLibrary.fingerprint, fingerprint));
    expect(row?.status).toBe('retired');
    expect(row?.negativeFeedbackCount).toBe(1);

    // Further uses never resurrect it.
    for (let i = 0; i < 6; i++) await library.writeCandidate('org_a', ev(), pack, output);
    expect(await library.lookup('org_a', ev(), pack)).toBeNull();
  });

  it('glossary_overrides outrank the global library', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    for (let i = 0; i < 5; i++) await library.writeCandidate('org_a', ev(), pack, output);

    const packWithGlossary = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      voice: {
        detail_level: 'plain_expandable',
        glossary_overrides: [{ term: 'build.succeeded', preferred_phrasing: 'new version is out the door.' }],
      },
    });
    const hit = await library.lookup('org_a', ev(), packWithGlossary);
    expect(hit?.source).toBe('glossary');
    expect(hit?.output.fragment).toBe('Loom: new version is out the door.');
  });
});
