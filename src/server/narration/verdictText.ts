import type { Verdict } from './types.js';

/**
 * The canonical rendering of each verdict. These exact strings are what
 * the digest validator and the eval harness check by containment
 * ("every input verdict present in output with meaning preserved") — the
 * composer may smooth around them but a fragment or brief that drops the
 * phrase fails validation. The phrases come from the docs' own examples:
 * "users are fine" (composer doc worked example), "can't tell yet"
 * (routing doc, global modifier 7).
 */
export const VERDICT_PHRASE: Record<Verdict, string> = {
  users_affected: 'users are affected',
  users_fine: 'users are fine',
  cannot_tell: "can't tell yet",
};

export function isVerdict(value: unknown): value is Verdict {
  return value === 'users_affected' || value === 'users_fine' || value === 'cannot_tell';
}
