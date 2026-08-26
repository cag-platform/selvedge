import { describe, expect, it } from 'vitest';
import { wantsVisual } from '../../src/shared/visualIntent.js';

describe('visual response intent', () => {
  it.each([
    '@gpt @claude give me a visual of a checkout card',
    'create an image showing the empty state',
    'I want two visual interpretations of this button',
    'mock up a pricing card',
  ])('recognises an explicit request: %s', (text) => expect(wantsVisual(text)).toBe(true));

  it.each(['show me the logs', 'what do you think of this design?', 'compare these two answers'])('does not turn ordinary language into image spend: %s', (text) => expect(wantsVisual(text)).toBe(false));
});
