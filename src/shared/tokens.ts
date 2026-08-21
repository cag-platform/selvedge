/**
 * A rough token count, with no tokenizer and no network.
 *
 * Every model tokenizes differently and none of them will tell you for free
 * before the call, so this is the standard ~4-characters-per-token
 * approximation, floored at one token for any non-empty string. It is used for
 * two honest purposes: sizing a payload against a budget before sending it, and
 * comparing two texts measured the same way (a handoff against the transcript
 * it replaces) — a ratio between two estimates from one estimator is meaningful
 * even when neither absolute number is exact.
 *
 * It is NOT used to bill anyone. Real spend comes back from the provider with
 * real token counts, and that is the only number the ledger records.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}
