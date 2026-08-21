import { describe, it, expect } from 'vitest';
import { extractDecision, parseDecision, transcriptFor } from '../../src/server/decisions/extract.js';
import { DownLlmClient, FakeLlmClient } from '../../src/server/llm/fake.js';

const conversation = [
  { role: 'owner', content: 'should the checkout be one page or three?' },
  { role: 'agent', content: 'One page usually converts better for short forms.' },
  { role: 'activity', content: 'Reading src/Cart.tsx' },
  { role: 'owner', content: "let's do one page, but keep the address step separate for delivery" },
];

describe('extracting what was decided', () => {
  it('shows the model the conversation, and only the conversation', () => {
    const transcript = transcriptFor(conversation);
    expect(transcript).toContain('one page or three');
    expect(transcript).toContain("let's do one page");
    // Tool activity is not conversation; it says nothing about what was decided.
    expect(transcript).not.toContain('src/Cart.tsx');
  });

  it('asks for the decision AND what was left open, and refuses to settle anything itself', async () => {
    const client = new FakeLlmClient((req) => ({
      ok: true,
      json: { title: 'One-page checkout', decision: 'Make the checkout one page.', why: 'Shorter forms convert better.', constraints: ['keep the address step separate'], open_questions: ['what happens to saved baskets?'] },
      tokensIn: 100,
      tokensOut: 50,
      model: req.model,
    }));
    const out = await extractDecision(client, 'anthropic', conversation);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.title).toBe('One-page checkout');
    expect(out.draft.constraints).toEqual(['keep the address step separate']);
    expect(out.draft.openQuestions).toEqual(['what happens to saved baskets?']);
    // The instruction that keeps a brief safe to build from.
    expect(client.requests[0]!.system).toMatch(/Never resolve one yourself/);
    expect(client.requests[0]!.system).toMatch(/Take nothing from outside the conversation/);
  });

  it('says it could not find one rather than inventing a decision', async () => {
    const empty = new FakeLlmClient((req) => ({ ok: true, json: { title: 'x', decision: '  ' }, tokensIn: 1, tokensOut: 1, model: req.model }));
    expect(await extractDecision(empty, 'anthropic', conversation)).toMatchObject({ ok: false });
    expect(await extractDecision(new DownLlmClient(), 'anthropic', conversation)).toMatchObject({ ok: false });
    expect(await extractDecision(empty, 'anthropic', [])).toMatchObject({ ok: false });
  });

  it('reads a shape it did not expect without throwing', () => {
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision({ decision: 'do the thing' })).toMatchObject({ title: 'A decision', constraints: [], openQuestions: [] });
    expect(parseDecision({ decision: 'x', constraints: 'not a list' })!.constraints).toEqual([]);
  });
});
