import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import { route } from '../../src/server/routing/route.js';
import { narrateDispatch, type NarrationLibraryPort } from '../../src/server/narration/dispatch.js';
import { FakeLlmClient, DownLlmClient } from '../../src/server/llm/fake.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarratableEvent, NarrationOutput } from '../../src/server/narration/types.js';

function testEvent(eventType: string): NarratableEvent {
  return { id: 'evt_1', org_id: 'org_1', event_type: eventType, occurred_at: '2026-07-19T10:00:00Z', severity_hint: 'error' };
}

const goodFragmentJson = {
  fragment: 'Loom: your update could not go live. The previous version is still running — users are fine.',
  verdict: 'users_fine',
  technical_line: 'deploy workflow failed on run 101',
  confidence: 'high',
};

describe('narrateDispatch', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    process.env.ANTHROPIC_API_KEY = 'test-key'; // llmEnabled() gate
  });
  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  function lcPack() {
    return makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
    });
  }

  it('returns null for SILENT decisions', async () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'build.started' }, pack);
    expect(await narrateDispatch(testEvent('build.started'), pack, decision)).toBeNull();
  });

  it('TEMPLATE rows never touch the model', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'code.pr_opened' }, pack); // A3: TEMPLATE at every tier
    const fake = new FakeLlmClient();
    const result = await narrateDispatch(testEvent('code.pr_opened'), pack, decision, { llm: fake, db });
    expect(result?.path).toBe('TEMPLATE');
    expect(fake.requests).toHaveLength(0);
  });

  it('without deps (Phase 1 mode), LLM-intended rows render the template and note llm_disabled', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const pack = lcPack();
    const decision = route({ event_type: 'build.failed' }, pack); // B4 LC: LLM+VERDICT
    const result = await narrateDispatch(testEvent('build.failed'), pack, decision);
    expect(result?.path).toBe('TEMPLATE');
    expect(result?.meta.fallback_reason).toBe('llm_disabled');
    expect(result?.output.verdict).toBe('users_fine'); // template's own honest verdict
  });

  it('LLM+VERDICT rows take the LLM path and meter the call', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'build.failed' }, pack);
    const fake = new FakeLlmClient((req) => ({ ok: true, json: goodFragmentJson, tokensIn: 900, tokensOut: 80, model: req.model }));

    const result = await narrateDispatch(testEvent('build.failed'), pack, decision, { llm: fake, db });
    expect(result?.path).toBe('LLM+VERDICT');
    expect(result?.output.verdict).toBe('users_fine');
    expect(result?.output.fragment).toContain('users are fine');

    const usage = await db.select().from(llmUsage).where(eq(llmUsage.orgId, 'org_1'));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.purpose).toBe('fragment');
    expect(usage[0]?.eventId).toBe('evt_1');
  });

  it('an LLM+VERDICT response without a verdict is a failed call -> template fallback, miss recorded', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'build.failed' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'Something happened.', technical_line: 't', confidence: 'high' }, // no verdict
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));

    const result = await narrateDispatch(testEvent('build.failed'), pack, decision, { llm: fake, db });
    expect(result?.path).toBe('TEMPLATE');
    expect(result?.meta.fallback_reason).toBe('missing_verdict');
    expect(result?.output.verdict).toBe('users_fine'); // B4 template verdict still honest
  });

  it('cannot_tell without a checking clause is a failed call', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'build.failed' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'Hmm.', verdict: 'cannot_tell', technical_line: 't', confidence: 'low' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));
    const result = await narrateDispatch(testEvent('build.failed'), pack, decision, { llm: fake, db });
    expect(result?.meta.fallback_reason).toBe('cannot_tell_without_checking');
  });

  it('model outage -> template fallback; the digest pipeline still gets a fragment', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'deploy.failed_previous_serving' }, pack); // B6 LC: LLM+VERDICT/PUSH
    const result = await narrateDispatch(testEvent('deploy.failed_previous_serving'), pack, decision, {
      llm: new DownLlmClient(),
      db,
    });
    expect(result?.path).toBe('TEMPLATE');
    expect(result?.meta.fallback_reason).toBe('network_or_timeout');
    expect(result?.output.fragment).toBeTruthy();
  });

  it('appends the canonical verdict phrase when the model forgot it', async () => {
    const pack = lcPack();
    const decision = route({ event_type: 'build.failed' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'The build broke before deploying.', verdict: 'users_fine', technical_line: 't', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));
    const result = await narrateDispatch(testEvent('build.failed'), pack, decision, { llm: fake, db });
    expect(result?.output.fragment).toContain('users are fine');
  });

  it('LIB rows check the library first, serve hits without a model call', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack); // B2 LS: LIB
    expect(decision.intended_path).toBe('LIB');

    const hit: NarrationOutput = { fragment: 'Loom: your update went live cleanly.' };
    const library: NarrationLibraryPort = {
      lookup: async () => ({ output: hit, source: 'library', fingerprint: 'fp' }),
      writeCandidate: async () => {},
      fingerprint: () => 'fp',
    };
    const fake = new FakeLlmClient();
    const result = await narrateDispatch(testEvent('build.succeeded'), pack, decision, { llm: fake, db, library });
    expect(result?.path).toBe('LIB');
    expect(result?.meta.lib_hit).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('LIB miss falls through to the LLM and writes a candidate', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack);

    const written: NarrationOutput[] = [];
    const library: NarrationLibraryPort = {
      lookup: async () => null,
      writeCandidate: async (_org, _event, _pack, output) => {
        written.push(output);
      },
      fingerprint: () => 'fp',
    };
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'Loom: shipped cleanly.', technical_line: 't', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));
    const result = await narrateDispatch(testEvent('build.succeeded'), pack, decision, { llm: fake, db, library });
    expect(result?.path).toBe('LIB');
    expect(result?.meta.lib_hit).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(written).toHaveLength(1);
  });

  it('carries the fingerprint even when the model fails and the template takes over', async () => {
    // Without it, a "didn't help" tap on a fallback narration logged the
    // complaint and retired nothing — the phrasing that failed the user kept
    // its place in the library. The feedback route reads meta.fingerprint.
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack);
    const library: NarrationLibraryPort = {
      lookup: async () => null,
      writeCandidate: async () => {},
      fingerprint: () => 'fp_build_succeeded',
    };
    const result = await narrateDispatch(testEvent('build.succeeded'), pack, decision, {
      llm: new DownLlmClient(),
      db,
      library,
    });
    expect(result?.meta.fallback_reason).toBe('network_or_timeout');
    expect(result?.meta.lib_hit).toBe(false);
    expect(result?.meta.fingerprint).toBe('fp_build_succeeded');
  });
});
