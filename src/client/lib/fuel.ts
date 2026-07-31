/**
 * Fuel provider display — the plain names an owner recognizes, kept pure so the
 * mapping is testable and used identically everywhere. "Fuel" is the model that
 * powers the voice; the owner brings their own (BYO), and these are the brands
 * they'd know, not the internal provider ids.
 */

export type FuelProvider = 'anthropic' | 'openai' | 'gemini' | 'kimi';

const LABEL: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT (OpenAI)',
  gemini: 'Gemini (Google)',
  kimi: 'Kimi',
};

export function fuelLabel(provider: string): string {
  return LABEL[provider] ?? provider;
}

/** Where the owner gets a key, so the connect form can point them there. */
const KEY_HINT: Record<string, string> = {
  anthropic: 'from console.anthropic.com → API Keys',
  openai: 'from platform.openai.com → API keys',
  gemini: 'from aistudio.google.com → Get API key',
  kimi: 'from platform.moonshot.cn → API keys',
};

export function keyHint(provider: string): string | null {
  return KEY_HINT[provider] ?? null;
}
