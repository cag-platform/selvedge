import { describe, it, expect } from 'vitest';
import { fuelLabel, keyHint } from '../../src/client/lib/fuel.js';

describe('fuel display — the owner sees brands, not provider ids', () => {
  it('maps each provider to the name the owner would recognize', () => {
    expect(fuelLabel('anthropic')).toBe('Claude');
    expect(fuelLabel('openai')).toBe('GPT (OpenAI)');
    expect(fuelLabel('gemini')).toBe('Gemini (Google)');
    expect(fuelLabel('kimi')).toBe('Kimi');
  });

  it('passes an unknown provider through unchanged rather than hiding it', () => {
    expect(fuelLabel('mistral')).toBe('mistral');
  });

  it('points the owner at where their key comes from, and is null for unknowns', () => {
    expect(keyHint('anthropic')).toMatch(/anthropic\.com/i);
    expect(keyHint('mistral')).toBeNull();
  });
});
