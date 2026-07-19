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

  it('candidates do not serve lookups; graduation at 5 uses within one org', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };

    for (let i = 0; i < 4; i++) {
      await library.writeCandidate('org_a', ev(), pack, output);
      expect(await library.lookup('org_a', ev(), pack)).toBeNull();
    }
    // 5th use graduates it.
    await library.writeCandidate('org_a', ev(), pack, output);
    const hit = await library.lookup('org_a', ev(), pack);
    expect(hit?.source).toBe('library');
    expect(hit?.output.fragment).toBe('Loom: your update went live cleanly.');
  });

  it('graduates at 3 uses across two orgs', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    await library.writeCandidate('org_a', ev(), pack, output);
    await library.writeCandidate('org_a', ev(), pack, output);
    expect(await library.lookup('org_a', ev(), pack)).toBeNull();
    await library.writeCandidate('org_b', ev({ org_id: 'org_b' }), pack, output);
    expect(await library.lookup('org_b', ev({ org_id: 'org_b' }), pack)).not.toBeNull();
  });

  it('serves a graduated phrasing across projects via the {project} slot', async () => {
    const output = { fragment: 'Loom: your update went live cleanly.' };
    for (let i = 0; i < 5; i++) await library.writeCandidate('org_a', ev(), pack, output);

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
    for (let i = 0; i < 5; i++) await library.writeCandidate('org_a', ev(), pack, output);

    expect(await library.lookup('org_a', ev({ signature: 'Completely Different Workflow' }), pack)).toBeNull();
  });

  it('retireByFingerprint sends a graduated entry back to the LLM path and bumps negative feedback', async () => {
    const output = { fragment: 'Loom: shipped.' };
    for (let i = 0; i < 5; i++) await library.writeCandidate('org_a', ev(), pack, output);
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
