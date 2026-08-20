/**
 * Collapsing identical repeats into one line with a plain count — three "edited
 * checkout.ts" lines are one fact that happened three times, not three facts.
 *
 * Lifted out of the digest composer (digest/order.ts) when the handoff composer
 * needed the same rule: a thread's activity repeats far harder than a day's
 * narrations do, and a payload that lists the same edit eleven times spends the
 * new agent's attention on nothing. One implementation, two callers, so the
 * phrasing can never drift between the brief and a handoff.
 */

/** "…landed today." + 3 → "…landed today (3 times)." — plain, inside the sentence. */
export function withTimesSuffix(line: string, count: number): string {
  const suffix = ` (${count} times)`;
  return line.endsWith('.') ? `${line.slice(0, -1)}${suffix}.` : `${line}${suffix}`;
}

/** Collapse repeated lines into one apiece, first-seen order preserved, counts said plainly. */
export function collapseRepeatedLines(lines: string[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const line of lines) {
    const seen = counts.get(line);
    if (seen === undefined) {
      counts.set(line, 1);
      order.push(line);
    } else {
      counts.set(line, seen + 1);
    }
  }
  return order.map((line) => {
    const count = counts.get(line)!;
    return count > 1 ? withTimesSuffix(line, count) : line;
  });
}
