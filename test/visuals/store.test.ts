import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { completeVisual, failVisual, queueVisual, visualById, visualsForThread } from '../../src/server/visuals/store.js';
import { visualObjectStore, visualStorageKey } from '../../src/server/visuals/storage.js';

describe('generated visual assets', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('moves from queued metadata to a durable object reference without storing image bytes', async () => {
    const queued = await queueVisual(db, 'org_1', {
      threadId: 'thread_1', consultationId: 'consult_1', directingAgent: 'claude',
      renderingProvider: 'openai', renderingModel: 'gpt-image-1', request: 'a brass checkout card',
    });
    expect(queued.status).toBe('queued');

    const ready = await completeVisual(db, 'org_1', queued.id, {
      renderPrompt: 'warm editorial checkout card', storageKey: 'generated/org_1/v.png',
      mime: 'image/png', width: 1024, height: 1024, bytes: 1234,
    });
    expect(ready).toMatchObject({ status: 'ready', storageKey: 'generated/org_1/v.png', bytes: 1234 });
    expect(await visualsForThread(db, 'org_1', 'thread_1')).toHaveLength(1);
    expect(await visualById(db, 'org_2', queued.id)).toBeNull();
  });

  it('records a failed render as a visible outcome', async () => {
    const queued = await queueVisual(db, 'org_1', {
      threadId: 'thread_1', directingAgent: 'gpt', renderingProvider: 'openai', renderingModel: 'gpt-image-1', request: 'x',
    });
    expect(await failVisual(db, 'org_1', queued.id, 'renderer unavailable')).toMatchObject({ status: 'failed', error: 'renderer unavailable' });
  });

  it('requires configured object storage and makes tenant-scoped keys', () => {
    expect(visualObjectStore({})).toBeNull();
    expect(visualStorageKey('org/acme', 'visual_1', 'image/webp')).toBe('generated/org%2Facme/visual_1.webp');
  });
});
