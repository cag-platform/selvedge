import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { route } from '../../src/server/routing/route.js';
import { narrate } from '../../src/server/narration/narrate.js';
import { narrateDispatch } from '../../src/server/narration/dispatch.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { DetailLevel } from '../../src/shared/types/pack.js';
import type { NarratableEvent } from '../../src/server/narration/types.js';

const REGISTERS: DetailLevel[] = ['plain_only', 'plain_expandable', 'technical_forward'];

function packAt(level: DetailLevel) {
  return makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
    stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
    voice: { detail_level: level },
  });
}

function ev(eventType: string): NarratableEvent {
  return { id: 'evt_1', org_id: 'org_1', event_type: eventType, occurred_at: '2026-07-19T10:00:00Z', severity_hint: 'error' };
}

/**
 * Phase 2 deliverable 8: all three registers over the same facts — verdicts
 * identical across registers. The register changes how much detail rides
 * along, never what the verdict is.
 */
describe('detail-level registers (deliverable 8)', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  it('template path: same facts, three registers, identical verdicts', () => {
    for (const eventType of ['build.failed', 'deploy.failed_previous_serving', 'deploy.failed_nothing_serving']) {
      const verdicts = REGISTERS.map((level) => {
        const pack = packAt(level);
        const decision = route({ event_type: eventType }, pack);
        return narrate(ev(eventType), pack, decision)?.verdict;
      });
      expect(new Set(verdicts).size).toBe(1);
    }
  });

  it('template path: technical_forward and plain_expandable carry the technical line; plain_only never does', () => {
    const byLevel = Object.fromEntries(
      REGISTERS.map((level) => {
        const pack = packAt(level);
        const decision = route({ event_type: 'build.failed' }, pack);
        return [level, narrate(ev('build.failed'), pack, decision)];
      }),
    );
    expect(byLevel.plain_only?.technicalDetail).toBeUndefined();
    expect(byLevel.plain_expandable?.technicalDetail).toBeTruthy();
    expect(byLevel.technical_forward?.technicalDetail).toBeTruthy();
  });

  it('LLM path: the register is passed to the prompt; the verdict is identical across registers', async () => {
    for (const level of REGISTERS) {
      const pack = packAt(level);
      const decision = route({ event_type: 'build.failed' }, pack); // LC B4: LLM+VERDICT
      const fake = new FakeLlmClient((req) => {
        expect(req.system).toContain(`detail level: ${level}`);
        return {
          ok: true,
          json: { fragment: 'Loom: build failed before deploy — users are fine.', verdict: 'users_fine', technical_line: 't', confidence: 'high' },
          tokensIn: 10,
          tokensOut: 10,
          model: req.model,
        };
      });
      const result = await narrateDispatch(ev('build.failed'), pack, decision, { llm: fake, db });
      expect(result?.output.verdict).toBe('users_fine');
      expect(fake.requests).toHaveLength(1);
    }
  });
});
