/**
 * MONEY, ON A SCREEN.
 *
 * One function, in one file, because it was two — `lib/card.ts` and
 * `lib/ledger.ts` each had their own copy, which is how two surfaces start
 * rounding the same number differently and nobody notices until a customer
 * does.
 *
 * IT CANNOT RENDER `NaN`. The old copies did `(cents / 100).toFixed(2)` on
 * whatever they were handed, so a field the server didn't send came out as
 * "$NaN" — which I hit within a minute of looking at a real screen. Of every
 * value in this product, the amount somebody is being charged is the one that
 * must never render as a JavaScript error. An amount we do not have is not
 * zero and it is not a number: it is unknown, and it says so.
 */

/** What a missing amount looks like. Never "$0.00" — unknown is not zero. */
export const UNKNOWN_AMOUNT = '—';

export function formatCents(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return UNKNOWN_AMOUNT;
  return `$${(cents / 100).toFixed(2)}`;
}

/** An estimate range, collapsed to one figure when the ends match. */
export function formatRange(low: number | null | undefined, high: number | null | undefined): string {
  const a = formatCents(low);
  const b = formatCents(high);
  if (a === UNKNOWN_AMOUNT || b === UNKNOWN_AMOUNT) return UNKNOWN_AMOUNT;
  return a === b ? a : `${a}–${b}`;
}
