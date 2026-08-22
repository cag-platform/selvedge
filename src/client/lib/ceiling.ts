/**
 * What the 409 from the message path carries when a conversation has spent
 * everything it was allowed to spend.
 *
 * The refusal is a pause, not a wall: the figures come back with it so the
 * surface can put the real number in front of the owner and offer the one word
 * that carries on. A ceiling nobody can see is the same as no ceiling.
 */
export type CeilingRefusal = {
  spent_cents: number;
  cap_cents: number;
  raises: number;
};

export function ceilingRefusalOf(body: Record<string, unknown>): CeilingRefusal | null {
  const hit = body.spend_ceiling as Partial<CeilingRefusal> | undefined;
  if (!hit || typeof hit.spent_cents !== 'number' || typeof hit.cap_cents !== 'number') return null;
  return {
    spent_cents: hit.spent_cents,
    cap_cents: hit.cap_cents,
    raises: typeof hit.raises === 'number' ? hit.raises : 0,
  };
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * What carrying on costs, said before it is pressed rather than after. The step
 * is one cap's worth — the same size as the one just used up, never a doubling
 * that gets away from the owner.
 */
export function raiseLabel(refusal: CeilingRefusal): string {
  const step = refusal.cap_cents / (refusal.raises + 1);
  return `Carry on up to ${money(refusal.cap_cents + step)}`;
}
