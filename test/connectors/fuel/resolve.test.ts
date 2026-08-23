import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { connectCredential } from '../../../src/server/connectors/credentials/store.js';
import { resolveFuel } from '../../../src/server/connectors/fuel/resolve.js';
import { AnthropicLlmClient } from '../../../src/server/llm/anthropic.js';

describe('fuel/resolve — BYO → managed → off', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_a';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    delete process.env.ANTHROPIC_API_KEY;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  it("uses the org's own key when it has one (BYO)", async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-org-key');
    const fuel = await resolveFuel(db, orgId);
    expect(fuel?.source).toBe('byo');
    expect(fuel?.provider).toBe('anthropic');
    expect(fuel?.client).toBeInstanceOf(AnthropicLlmClient);
  });

  it('BYO beats the platform key even when both exist', async () => {
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-org-key');
    const fuel = await resolveFuel(db, orgId);
    expect(fuel?.source).toBe('byo');
  });

  it('falls back to the platform key when the org has no fuel (managed)', async () => {
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    const fuel = await resolveFuel(db, orgId);
    expect(fuel?.source).toBe('managed');
    expect(fuel?.provider).toBe('anthropic');
  });

  it('returns null when there is no org fuel and no platform key (off)', async () => {
    expect(await resolveFuel(db, orgId)).toBeNull();
  });

  it("does not use another org's fuel", async () => {
    await db.insert(orgs).values({ orgId: 'org_b' });
    await connectCredential(db, 'org_b', 'anthropic', 'sk-ant-b-key');
    // org_a has nothing of its own and no platform key → off, NOT org_b's key.
    expect(await resolveFuel(db, orgId)).toBeNull();
  });

  it('skips a stored credential for a provider it cannot build, rather than failing', async () => {
    // Every DECLARED provider is buildable now, so the subject of this test had
    // to change — but the rule it protects did not. A credential row for
    // something the resolver doesn't recognise (a retired provider, a hand-
    // written row, a provider added to the table and then removed) must be
    // stepped over rather than throwing, because the failure would be "no fuel
    // at all" for an org that has perfectly good keys next to it.
    await connectCredential(db, orgId, 'some-provider-we-do-not-have', 'key-for-nothing');
    expect(await resolveFuel(db, orgId)).toBeNull();
  });

  it('now builds a client for a provider that used to be declared-only', async () => {
    // Gemini and Kimi sat in the table for months as roadmap. The seam they
    // were waiting for is one base URL per provider.
    await connectCredential(db, orgId, 'kimi', 'sk-moonshot-test');
    const fuel = await resolveFuel(db, orgId);
    expect(fuel?.provider).toBe('kimi');
    expect(fuel?.source).toBe('byo');
  });
});
