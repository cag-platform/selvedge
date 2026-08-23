import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { resolveBuilderAuth, builderAvailability, managedFuelAllowed } from '../../src/server/build/builderAuth.js';
import { claudeCommand } from '../../src/server/runner/daytona/agentCommand.js';
import { driverFor } from '../../src/server/runner/agents/driver.js';
import { createPack } from '../../src/server/packs/store.js';
import { scaffoldPack } from '../../src/server/packs/scaffold.js';
import { agentRoster } from '../../src/server/threads/roster.js';
import { createThread } from '../../src/server/threads/store.js';
import { resolveFuel, resolveFuelFor } from '../../src/server/connectors/fuel/resolve.js';

/**
 * WHOSE ACCOUNT THE BUILDER RUNS ON.
 *
 * The same bug, found for the third time. One job, two identities: a surface
 * asks the org who they are, and the thing that does the work uses the
 * platform's credentials instead. GitHub had it (repoToken), OpenAI had it
 * (Codex), and Claude Code kept it longest — its token came out of
 * `process.env` with no org in scope, so every build turn every customer would
 * ever run went on ONE account's Claude subscription.
 *
 * The rule under test, for EVERY builder and not just the one that was fixed
 * most recently: the org's own account first, the platform's only if this
 * deployment offers that, and a sentence naming the fix when there is neither.
 */
describe('every builder runs on the org’s own account', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'mine';
  const noPlatform: NodeJS.ProcessEnv = {};

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

  describe('Claude Code — the one that was still on the platform’s subscription', () => {
    it("runs on the org's own connected Anthropic key", async () => {
      await connectCredential(db, orgId, 'anthropic', 'sk-ant-owner', { kind: 'api_key' });
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'platform-token' } });
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.auth.secret).toBe('sk-ant-owner');
      expect(got.auth.source).toBe('byo');
    });

    /**
     * THE POINT OF STORING A KIND. The Claude Code CLI reads a subscription
     * token and an API key from DIFFERENT variables. Putting one in the other's
     * place doesn't error — the CLI simply finds no credentials, deep inside a
     * sandbox the owner has already been metered for.
     */
    it('sends a subscription token and an API key to different variables', async () => {
      await connectCredential(db, orgId, 'anthropic', 'sk-ant-owner', { kind: 'api_key' });
      const asKey = await resolveBuilderAuth(db, orgId, 'claude-code', { env: noPlatform });
      expect(asKey.ok && asKey.auth.envVar).toBe('ANTHROPIC_API_KEY');

      await connectCredential(db, orgId, 'anthropic', 'sk-ant-oat-subscription', { kind: 'subscription' });
      const asSub = await resolveBuilderAuth(db, orgId, 'claude-code', { env: noPlatform });
      expect(asSub.ok && asSub.auth.envVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
      expect(asSub.ok && asSub.auth.kind).toBe('subscription');
    });

    it('says what to connect when the org has nothing and the deployment covers nothing', async () => {
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: noPlatform });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      // A refusal a person can act on: it names the credential AND the screen.
      expect(got.note).toMatch(/Anthropic/i);
      expect(got.note).toMatch(/subscription/i);
      expect(got.note).toMatch(/Connections/);
    });

    it("never hands one org's credential to another", async () => {
      await connectCredential(db, 'theirs', 'anthropic', 'sk-ant-not-yours', { kind: 'api_key' });
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: noPlatform });
      expect(got.ok).toBe(false);
    });
  });

  describe('Codex — same order, and an honest no for the case that cannot work', () => {
    it("runs on the org's own OpenAI key", async () => {
      await connectCredential(db, orgId, 'openai', 'sk-owner-key', { kind: 'api_key' });
      const got = await resolveBuilderAuth(db, orgId, 'codex', { env: { OPENAI_API_KEY: 'sk-platform' } });
      expect(got.ok && got.auth.secret).toBe('sk-owner-key');
      expect(got.ok && got.auth.envVar).toBe('OPENAI_API_KEY');
    });

    /**
     * A credential of the wrong SORT is refused by name — never quietly swapped
     * for the platform's. Falling back there would spend the deployment's money
     * for an org that has connected their own account and would never find out
     * why their bill didn't move.
     */
    it('refuses a ChatGPT subscription by name rather than trying it as a key', async () => {
      await connectCredential(db, orgId, 'openai', 'chatgpt-session-token', { kind: 'subscription' });
      const got = await resolveBuilderAuth(db, orgId, 'codex', { env: { OPENAI_API_KEY: 'sk-platform' } });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.note).toMatch(/API key/i);
      expect(got.note).toMatch(/subscription/i);
    });

    it('is not a builder at all when asked about a talker', async () => {
      const got = await resolveBuilderAuth(db, orgId, 'gemini', { env: noPlatform });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.note).toMatch(/doesn’t build|doesn't build/);
    });
  });

  describe('the platform’s own account is a fallback, and a switchable one', () => {
    it('covers an org that has connected nothing, and says so in `source`', async () => {
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'platform-token' } });
      expect(got.ok && got.auth.source).toBe('managed');
      expect(got.ok && got.auth.secret).toBe('platform-token');
    });

    /** A subscription seat already paid for beats metered tokens. */
    it('prefers the deployment’s subscription over its API key when it holds both', async () => {
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'platform-token', ANTHROPIC_API_KEY: 'sk-platform' },
      });
      expect(got.ok && got.auth.envVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    });

    /**
     * THE LEVER. The day BYO is the promise rather than the default, this is
     * the switch: every org builds on its own account or is told plainly that
     * it needs one. Default stays ON, because a deploy is the wrong moment to
     * discover a policy change.
     */
    it('MANAGED_FUEL=off stops the deployment covering anybody', async () => {
      expect(managedFuelAllowed({})).toBe(true);
      expect(managedFuelAllowed({ MANAGED_FUEL: 'off' })).toBe(false);

      const got = await resolveBuilderAuth(db, orgId, 'claude-code', {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'platform-token', MANAGED_FUEL: 'off' },
      });
      expect(got.ok).toBe(false);
    });

    it('still runs an org on its OWN account with the fallback off', async () => {
      await connectCredential(db, orgId, 'anthropic', 'sk-ant-owner', { kind: 'api_key' });
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: { MANAGED_FUEL: 'off' } });
      expect(got.ok && got.auth.source).toBe('byo');
    });
  });

  /**
   * THE SECRET HAS TO ARRIVE AT THE CLI. A resolver that returns the right
   * credential to a driver that doesn't use it is the same bug wearing a
   * different hat.
   */
  describe('and it reaches the command the sandbox runs', () => {
    it('puts the credential on the turn, in the variable its kind decided', async () => {
      await connectCredential(db, orgId, 'anthropic', 'sk-ant-oat', { kind: 'subscription' });
      const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: noPlatform });
      expect(got.ok).toBe(true);
      if (!got.ok) return;

      const driver = driverFor('claude-code', got.auth)!;
      const command = driver.command('make it darker', { mode: 'build' });
      expect(command).toContain("CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat'");
      expect(command).not.toContain('ANTHROPIC_API_KEY=');
    });

    it('quotes a secret so a shell can’t be talked into anything by one', async () => {
      const command = claudeCommand('hi', 'sonnet', null, 'build', {
        envVar: 'ANTHROPIC_API_KEY',
        secret: "x'; rm -rf /; echo '",
      });
      expect(command).toContain(`ANTHROPIC_API_KEY='x'\\''; rm -rf /; echo '\\'''`);
    });

    it('builds no driver at all without a credential, for either builder', () => {
      expect(driverFor('claude-code', null)).toBeNull();
      expect(driverFor('codex', null)).toBeNull();
    });
  });

  /**
   * THE PICKER MUST SAY WHAT THE TURN WOULD DO. A roster with its own opinion
   * about availability is a roster that eventually disagrees with the thing it
   * describes — which is exactly how "no OpenAI key" ended up being shown to an
   * owner looking at their connected OpenAI key on the next screen.
   */
  describe('the roster agrees with the resolver', () => {
    const engineOn = () => ({ daytonaApiKey: 'd' });
    const withoutPlatform = (d: TestDb, org: string, agent: Parameters<typeof builderAvailability>[2]) =>
      builderAvailability(d, org, agent, { env: {} });

    async function thread() {
      await createPack(db, orgId, scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
      return createThread(db, orgId, 'balance', { kind: 'general', title: 'Thinking' });
    }

    it('offers a builder whose org has connected an account', async () => {
      await connectCredential(db, orgId, 'anthropic', 'sk-ant-owner', { kind: 'api_key' });
      const roster = await agentRoster(db, orgId, await thread(), engineOn, withoutPlatform);
      const cc = roster.find((a) => a.id === 'claude-code');
      expect(cc?.available).toBe(true);
      expect(cc?.unavailable_note).toBeNull();
    });

    it('says why not, and where to fix it, for BOTH builders when nothing is connected', async () => {
      const roster = await agentRoster(db, orgId, await thread(), engineOn, withoutPlatform);
      for (const id of ['claude-code', 'codex']) {
        const row = roster.find((a) => a.id === id);
        expect(row?.available).toBe(false);
        // A greyed row with no remedy is what makes people think a product is broken.
        expect(row?.unavailable_note).toMatch(/Connections/);
      }
    });

    it('offers Codex on its own key without Claude Code borrowing it', async () => {
      await connectCredential(db, orgId, 'openai', 'sk-owner-key', { kind: 'api_key' });
      const roster = await agentRoster(db, orgId, await thread(), engineOn, withoutPlatform);
      expect(roster.find((a) => a.id === 'codex')?.available).toBe(true);
      expect(roster.find((a) => a.id === 'claude-code')?.available).toBe(false);
    });

    it('blames the deployment, not the owner, when there is nowhere to run', async () => {
      const roster = await agentRoster(db, orgId, await thread(), () => null, withoutPlatform);
      const builders = roster.filter((a) => a.changes_files);
      expect(builders.every((a) => !a.available)).toBe(true);
      // No machine is not something a credential fixes, so it must not offer one.
      expect(builders[0]!.unavailable_note).toMatch(/build engine isn't switched on/i);
      expect(builders[0]!.unavailable_note).not.toMatch(/Connections/);
    });
  });
});

/**
 * ONE CREDENTIAL ROW, TWO SURFACES — and only one of them can use a
 * subscription.
 *
 * Connecting an Anthropic subscription arms the Claude Code BUILDER. The same
 * row is what a @claude chat turn reads, and a subscription token does not
 * authenticate against the messages API: it authenticates a CLI. Without this,
 * an owner who connected a subscription would arm their builds and break their
 * chat in the same click, and the failure would read as "your Claude
 * connection stopped working".
 */
describe('a subscription arms the builder without breaking chat', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'mine';

  beforeEach(async () => {
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it('does not hand a subscription token to the chat client', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-oat-subscription', { kind: 'subscription' });
    // Skipped, not failed: no platform key either, so chat degrades to the
    // deterministic path exactly as it does when nothing is connected.
    expect(await resolveFuelFor(db, orgId, 'anthropic')).toBeNull();
    expect(await resolveFuel(db, orgId)).toBeNull();
  });

  it('still arms the builder with the very same row', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-oat-subscription', { kind: 'subscription' });
    const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: {} });
    expect(got.ok && got.auth.envVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('leaves an API key working for both', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-real-key', { kind: 'api_key' });
    expect(await resolveFuelFor(db, orgId, 'anthropic')).not.toBeNull();
    const got = await resolveBuilderAuth(db, orgId, 'claude-code', { env: {} });
    expect(got.ok && got.auth.envVar).toBe('ANTHROPIC_API_KEY');
  });
});
