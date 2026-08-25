import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { cards, orgs, narrations, narrationLibrary } from '../../src/server/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { createMemoryRouter } from '../../src/server/web/routes/memory.js';
import { createPortabilityRouter } from '../../src/server/web/routes/portability.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/memory', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'orders' } }));
  });
  afterEach(async () => close());

  it('serves the stack roll-up and a per-project memory', async () => {
    await db.insert(narrationLibrary).values({ id: ulid(), fingerprint: 'fp1', phrasing: { fragment: '{project} flaky check' }, status: 'graduated' });
    await db.insert(narrations).values({
      id: ulid(), orgId, projectId: 'loom', eventId: ulid(), eventType: 'build.failed',
      occurredAt: new Date(), path: 'LIB', intendedPath: 'LIB', delivery: 'DIGEST', meta: { fingerprint: 'fp1' },
    });

    const app = appWithOrg(orgId, createMemoryRouter(db));

    const stack = await request(app).get('/api/memory');
    expect(stack.status).toBe(200);
    expect(stack.body.apps).toBe(1);
    expect(typeof stack.body.summary).toBe('string');

    const project = await request(app).get('/api/projects/loom/memory');
    expect(project.status).toBe(200);
    expect(project.body.learned_signatures[0].plain).toBe('Loom flaky check');

    // The signed-in product reads the same grounded context handed to an
    // external agent; the memory UI must never drift into a second model.
    const context = await request(app).get('/api/projects/loom/context');
    expect(context.status).toBe(200);
    expect(context.body.project).toMatchObject({ id: 'loom', name: 'Loom' });
    expect(context.body.sections.about.join(' ')).toContain('orders');

    const missing = await request(app).get('/api/projects/nope/memory');
    expect(missing.status).toBe(404);
    expect((await request(app).get('/api/projects/nope/context')).status).toBe(404);
  });
});

describe('web/routes/portability', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'orders' } }));
  });
  afterEach(async () => close());

  it('exports a bundle that re-imports into another org (round-trip)', async () => {
    const exportApp = appWithOrg(orgId, createPortabilityRouter(db));
    const exported = await request(exportApp).get('/api/export');
    expect(exported.status).toBe(200);
    expect(exported.body.selvedge_export_version).toBe('1');
    expect(exported.body.packs).toHaveLength(1);

    // Import into a fresh org — the pack is restored there.
    await db.insert(orgs).values({ orgId: 'org_2' });
    const importApp = appWithOrg('org_2', createPortabilityRouter(db));
    const imported = await request(importApp).post('/api/context/restore').send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.restored).toBe(1);

    expect(await getPack(db, 'org_2', 'loom')).not.toBeNull();
  });

  it('carries the history the timeline shows — the same record, in the file', async () => {
    // The timeline tells the owner on screen that what they are reading is
    // theirs to take. That claim has to be true in the export, not only in the
    // copy, so this is the test that keeps the two honest with each other.
    await db.insert(cards).values({
      id: 'c1',
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: 'guest checkout',
      proposal: 'Let people buy without an account.',
      risk: 'ordinary',
      gate: 'normal',
      state: 'done',
      verdict: 'verified',
      estimate: {},
      stop: {},
      acts: [],
    });

    const exported = await request(appWithOrg(orgId, createPortabilityRouter(db))).get('/api/export');
    const sentences = (exported.body.timeline ?? []).map((e: { sentence: string }) => e.sentence).join('\n');
    expect(sentences).toContain('guest checkout');
    expect(exported.body.timeline.every((e: { project_id: string }) => e.project_id === 'loom')).toBe(true);

    // ...and it stays version 1: the field is additive, so a bundle exported
    // before it existed still imports, and history is never re-seeded into
    // another org — importing a past would be manufacturing one.
    expect(exported.body.selvedge_export_version).toBe('1');
    await db.insert(orgs).values({ orgId: 'org_3' });
    const imported = await request(appWithOrg('org_3', createPortabilityRouter(db))).post('/api/context/restore').send(exported.body);
    expect(imported.status).toBe(200);
    expect(await db.select().from(cards).where(eq(cards.orgId, 'org_3'))).toEqual([]);
  });

  it('400s on a body that is not a bundle', async () => {
    const app = appWithOrg(orgId, createPortabilityRouter(db));
    expect((await request(app).post('/api/context/restore').send({ nope: true })).status).toBe(400);
  });
});
