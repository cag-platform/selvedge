import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { resolveOpenAiKey } from '../../src/server/build/openaiKey.js';
import { configFor } from '../../src/server/build/engineConfig.js';
import { createPack } from '../../src/server/packs/store.js';
import { scaffoldPack } from '../../src/server/packs/scaffold.js';
import { agentRoster } from '../../src/server/threads/roster.js';
import { createThread } from '../../src/server/threads/store.js';

/**
 * THE SECOND HALF OF THE SAME BUG AS repoToken.
 *
 * One job, two identities. Ask GPT something in a thread and it runs on the key
 * YOUR workspace connected. Ask Codex to build something and it ran on the
 * deployment's environment variable and nothing else — so an owner with a
 * perfectly good connected OpenAI key was told Codex wasn't switched on, or
 * worse, was charged for a sandbox that died on a 401.
 *
 * The rule under test: "connect your OpenAI key" means one thing, and it means
 * the same thing for the builder as for the talker — yours first, the
 * platform's as a fallback, nothing when there is neither.
 */
describe('the key Codex builds with is the key you connected', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'mine';

  beforeEach(async () => {
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'theirs' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it("prefers the org's own connected key over the platform's", async () => {
    await connectCredential(db, orgId, 'openai', 'sk-owner-key');
    const key = await resolveOpenAiKey(db, orgId, { platformKey: () => 'sk-platform' });
    expect(key).toBe('sk-owner-key');
  });

  it('falls back to the platform key when the org has connected none', async () => {
    expect(await resolveOpenAiKey(db, orgId, { platformKey: () => 'sk-platform' })).toBe('sk-platform');
  });

  it('is null when there is neither, rather than an empty string that reads as a key', async () => {
    expect(await resolveOpenAiKey(db, orgId, { platformKey: () => '   ' })).toBeNull();
    expect(await resolveOpenAiKey(db, orgId, { platformKey: () => undefined })).toBeNull();
  });

  it("never hands one org's key to another", async () => {
    await connectCredential(db, 'theirs', 'openai', 'sk-not-yours');
    expect(await resolveOpenAiKey(db, orgId, { platformKey: () => undefined })).toBeNull();
  });

  it('reaches the sandbox config, so the build runs on it', async () => {
    // The whole point: a key connected in the UI has to arrive at the CLI
    // inside the sandbox, not stop at the seam.
    await createPack(db, orgId, scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
    const result = await configFor(
      db,
      orgId,
      'balance',
      () => ({ claudeCodeOauthToken: 'cc' }),
      async () => ({ ok: true, token: 'ghs_x', source: 'installation' }),
      async () => 'sk-owner-key',
    );
    expect('cfg' in result && result.cfg.openaiApiKey).toBe('sk-owner-key');
  });

  it('leaves the key off the config entirely when there is none', async () => {
    // Codex's driver returns null without one — which is how it stops being
    // offered. An empty string there would be a key as far as that check goes.
    await createPack(db, orgId, scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
    const result = await configFor(
      db,
      orgId,
      'balance',
      () => ({ claudeCodeOauthToken: 'cc' }),
      async () => ({ ok: true, token: 'ghs_x', source: 'installation' }),
      async () => null,
    );
    expect('cfg' in result && 'openaiApiKey' in result.cfg).toBe(false);
  });

  describe('and the roster says the same thing as the builder does', () => {
    it('offers Codex to an org whose own key is connected', async () => {
      // The bug in the row: this used to read the deployment's environment, so
      // it could say "no OpenAI key" to somebody looking at their connected
      // OpenAI key on the next screen.
      await connectCredential(db, orgId, 'openai', 'sk-owner-key');
      await createPack(db, orgId, scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
      const thread = await createThread(db, orgId, 'balance', { kind: 'general', title: 'Thinking' });
      const roster = await agentRoster(db, orgId, thread, () => ({ claudeCodeOauthToken: 'cc' }));
      const codex = roster.find((a) => a.id === 'codex');
      expect(codex?.available).toBe(true);
      expect(codex?.unavailable_note).toBeNull();
    });

    it('says why not, and where to fix it, when there is no key anywhere', async () => {
      await createPack(db, orgId, scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
      const thread = await createThread(db, orgId, 'balance', { kind: 'general', title: 'Thinking' });
      const roster = await agentRoster(db, orgId, thread, () => ({ claudeCodeOauthToken: 'cc' }), async () => null);
      const codex = roster.find((a) => a.id === 'codex');
      expect(codex?.available).toBe(false);
      // A greyed row with no remedy is what makes people think a product is broken.
      expect(codex?.unavailable_note).toMatch(/Connections/);
      // And the other builder is unaffected by Codex's fuel.
      expect(roster.find((a) => a.id === 'claude-code')?.available).toBe(true);
    });
  });
});
