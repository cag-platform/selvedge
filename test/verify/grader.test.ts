import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import { gradeAcceptance, GRADE_SCHEMA } from '../../src/server/verify/grader.js';
import { strictable } from '../../src/server/llm/openai.js';
import { FakeLlmClient, DownLlmClient } from '../../src/server/llm/fake.js';
import { generateChecks, runCheckSpec, type JudgeAnswer } from '../../src/server/verify/checks.js';
import { computeVerdict } from '../../src/server/verify/verdict.js';
import { shapeEvidence, renderEvidence, MAX_FILES } from '../../src/server/verify/evidence.js';

const SPEC = { ask: 'make the gift note optional', evidence: '--- src/Checkout.tsx\n-required\n+optional' };

describe('gradeAcceptance — the independent grader never guesses', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, plan: 'studio' });
  });
  afterEach(async () => close());

  const answering = (outcome: string, reason = 'because') =>
    new FakeLlmClient((req) => ({ ok: true, json: { outcome, reason }, tokensIn: 100, tokensOut: 20, model: req.model, provider: 'openai' }));

  it('passes a change the diff shows did what was asked, with a plain reason', async () => {
    const out = await gradeAcceptance({ llm: answering('pass', 'the field is optional now'), db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    expect(out).toEqual({ outcome: 'pass', detail: 'the field is optional now' });
  });

  it('carries a fail through — with the reason the owner will read', async () => {
    const out = await gradeAcceptance({ llm: answering('fail', 'the field is still required'), db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    expect(out.outcome).toBe('fail');
  });

  it('an unreachable grader is cannot_tell — never a default opinion', async () => {
    const out = await gradeAcceptance({ llm: new DownLlmClient(), db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    expect(out.outcome).toBe('cannot_tell');
    expect(out.detail).toMatch(/could not be reached/);
  });

  it('a malformed answer is cannot_tell — an unusable answer is not an answer', async () => {
    const weird = new FakeLlmClient((req) => ({ ok: true, json: { outcome: 'sure!' }, tokensIn: 1, tokensOut: 1, model: req.model }));
    const out = await gradeAcceptance({ llm: weird, db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    expect(out.outcome).toBe('cannot_tell');
  });

  it('meters every call under its own purpose, success or failure', async () => {
    await gradeAcceptance({ llm: answering('pass'), db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    await gradeAcceptance({ llm: new DownLlmClient(), db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    const rows = await db.select().from(llmUsage);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.purpose === 'grade')).toBe(true);
  });

  it('stops at the grading allowance and says so — the budget carve-out working', async () => {
    // trial's grading allowance is $0.10; a recorded $1 grade exhausts it.
    await db.update(orgs).set({ plan: 'trial' });
    await db.insert(llmUsage).values({
      id: 'u1', orgId, purpose: 'grade', model: 'gpt-5.6-luna', provider: 'openai',
      tokensIn: 1, tokensOut: 1, costUsd: 1.0, ok: 'true',
    });
    const llm = answering('pass');
    const out = await gradeAcceptance({ llm, db, model: 'gpt-5.6-luna' }, orgId, SPEC);
    expect(out.outcome).toBe('cannot_tell');
    expect(out.detail).toMatch(/allowance/);
    expect(llm.requests).toHaveLength(0); // over budget means no call, not a cheaper call
  });

  it('GRADE_SCHEMA is strict-compatible, so the OpenAI adapter guarantees the shape', () => {
    // FRAGMENT_SCHEMA deliberately is not (optional properties) — this one must
    // be, because a schema-guaranteed answer is what makes the malformed-answer
    // guard above nearly unreachable rather than routine.
    expect(strictable(GRADE_SCHEMA as unknown as Record<string, unknown>)).toBe(true);
  });
});

describe('the judged acceptance check — the inversion, stated', () => {
  const judged = generateChecks({
    liveUrl: 'https://x.example',
    requestText: 'make the gift note optional',
    evidence: '--- a.ts\n+x',
  }).find((s) => s.kind === 'acceptance')!;

  it('emits judged when there is both an ask and evidence', () => {
    expect(judged.how.via).toBe('judged');
  });

  it('emits manual — not judged — when there is no evidence to judge', () => {
    const specs = generateChecks({ liveUrl: 'https://x.example', requestText: 'make it optional' });
    expect(specs.find((s) => s.kind === 'acceptance')!.how.via).toBe('manual');
  });

  it('no judge configured → could_not_run, and the verdict caps at probably', async () => {
    const result = await runCheckSpec(judged, {});
    expect(result.outcome).toBe('could_not_run');
    expect(result.detail).toMatch(/no independent grader/);
    // The verdict this feeds: smoke up + ungraded acceptance = probably. Never verified.
    expect(computeVerdict([{ kind: 'smoke', name: 's', outcome: 'pass' }, result])).toBe('probably');
  });

  it('a judge pass makes verified reachable — the top verdict, unlocked', async () => {
    const judge = async (): Promise<JudgeAnswer> => ({ outcome: 'pass', detail: 'it does' });
    const result = await runCheckSpec(judged, { judge });
    expect(result.outcome).toBe('pass');
    expect(computeVerdict([{ kind: 'smoke', name: 's', outcome: 'pass' }, result])).toBe('verified');
  });

  it("the judge's cannot_tell maps to could_not_run — never rounded to pass or fail", async () => {
    const judge = async (): Promise<JudgeAnswer> => ({ outcome: 'cannot_tell', detail: 'diff truncated' });
    const result = await runCheckSpec(judged, { judge });
    expect(result.outcome).toBe('could_not_run');
    expect(computeVerdict([{ kind: 'smoke', name: 's', outcome: 'pass' }, result])).toBe('probably');
  });

  it('a judge that throws is could_not_run, not a crashed verdict', async () => {
    const judge = async (): Promise<JudgeAnswer> => { throw new Error('boom'); };
    const result = await runCheckSpec(judged, { judge });
    expect(result.outcome).toBe('could_not_run');
  });
});

describe('evidence — bounded, and honest about its bounds', () => {
  it('shapes a compare into paths and patch text', () => {
    const ev = shapeEvidence([{ filename: 'a.ts', patch: '+x' }, { filename: 'b.ts', patch: '+y' }])!;
    expect(ev.paths).toEqual(['a.ts', 'b.ts']);
    expect(ev.truncated).toBe(false);
    expect(ev.diff).toContain('--- a.ts');
  });

  it('returns null for an empty compare — nothing changed is nothing to grade', () => {
    expect(shapeEvidence([])).toBeNull();
  });

  it('names a binary file rather than omitting it silently', () => {
    const ev = shapeEvidence([{ filename: 'logo.png' }])!;
    expect(ev.diff).toContain('logo.png (no textual diff available)');
  });

  it('truncates a huge change and TELLS THE GRADER it did', () => {
    const files = Array.from({ length: MAX_FILES + 10 }, (_, i) => ({ filename: `f${i}.ts`, patch: '+x' }));
    const ev = shapeEvidence(files)!;
    expect(ev.truncated).toBe(true);
    // Every path still reported — the scope of the change is itself evidence.
    expect(ev.paths).toHaveLength(MAX_FILES + 10);
    expect(renderEvidence(ev)).toMatch(/truncated/);
    expect(renderEvidence(ev)).toMatch(/cannot_tell/);
  });
});
