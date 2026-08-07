import { describe, it, expect } from 'vitest';
import { strictable } from '../../src/server/llm/openai.js';
import { FRAGMENT_SCHEMA } from '../../src/server/narration/llmFragment.js';

/**
 * The network half of openai.ts is unverified-until-live, like every other
 * connector in this codebase. What IS testable is the one decision the adapter
 * makes on its own: whether a schema can be sent under strict mode.
 *
 * It matters because getting it wrong fails loudly in the wrong direction —
 * asserting strict on a schema OpenAI won't accept turns a degraded call into
 * a hard API error, and the brief's whole degradation story is that a model
 * problem drops to the deterministic path rather than breaking the page.
 */
describe('strictable — strict mode only where OpenAI will actually accept it', () => {
  const closed = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a', 'b'],
  };

  it('accepts a closed object whose properties are all required', () => {
    expect(strictable(closed)).toBe(true);
  });

  it('refuses an open object — additionalProperties must be false', () => {
    expect(strictable({ ...closed, additionalProperties: true })).toBe(false);
    const { additionalProperties: _drop, ...noFlag } = closed;
    expect(strictable(noFlag)).toBe(false);
  });

  it('refuses a schema with an optional property', () => {
    expect(strictable({ ...closed, required: ['a'] })).toBe(false);
  });

  it('refuses anything that is not an object schema', () => {
    expect(strictable({ type: 'array', items: { type: 'string' } })).toBe(false);
    expect(strictable({})).toBe(false);
  });

  it('refuses a malformed schema rather than throwing on it', () => {
    // A bad schema should degrade to best-effort, not crash the call.
    expect(strictable({ type: 'object', additionalProperties: false, properties: null, required: [] })).toBe(false);
    expect(strictable({ type: 'object', additionalProperties: false, properties: {}, required: 'a' })).toBe(false);
  });

  it("reports honestly on this codebase's own narration schema", () => {
    // Not an assertion that it must be strict-compatible — just that the check
    // returns a definite answer for a real schema rather than throwing.
    expect(typeof strictable(FRAGMENT_SCHEMA as Record<string, unknown>)).toBe('boolean');
  });
});
