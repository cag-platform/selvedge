import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { buildNarrationDeps, buildComposeDeps, buildAskDeps } from '../../src/server/llm/factory.js';

/**
 * The per-org pivot: the voice is powered by each org's own fuel, decided at
 * use time. A BYO org gets deps (a voice); an org with no fuel and no platform
 * key gets undefined (the mechanical, deterministic path). This is what makes
 * "voice on/off" a per-tenant fact rather than a global env switch.
 */
describe('llm/factory — deps follow the org, not the process', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    delete process.env.ANTHROPIC_API_KEY;
    await db.insert(orgs).values([{ orgId: 'byo' }, { orgId: 'bare' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  it('an org with its own key gets a voice on every surface', async () => {
    await connectCredential(db, 'byo', 'anthropic', 'sk-ant-byo-key');
    expect(await buildNarrationDeps(db, 'byo')).toBeDefined();
    expect(await buildComposeDeps(db, 'byo')).toBeDefined();
    expect(await buildAskDeps(db, 'byo')).toBeDefined();
  });

  it('an org with no fuel and no platform key gets the mechanical path', async () => {
    expect(await buildNarrationDeps(db, 'bare')).toBeUndefined();
    expect(await buildComposeDeps(db, 'bare')).toBeUndefined();
    expect(await buildAskDeps(db, 'bare')).toBeUndefined();
  });

  it('one org can have a voice while another, in the same process, does not', async () => {
    await connectCredential(db, 'byo', 'anthropic', 'sk-ant-byo-key');
    expect(await buildNarrationDeps(db, 'byo')).toBeDefined();
    expect(await buildNarrationDeps(db, 'bare')).toBeUndefined();
  });

  it('the platform key gives a managed org a voice when it has no key of its own', async () => {
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    expect(await buildComposeDeps(db, 'bare')).toBeDefined(); // managed fallback
  });
});
