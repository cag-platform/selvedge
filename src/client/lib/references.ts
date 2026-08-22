import { referencedNames } from '../../shared/references.js';

/**
 * THE `#` PICKER, CLIENT-SIDE — the wire shape of `/api/references` and the
 * pure rules the composer needs around it.
 *
 * Same shape as lib/agents.ts does for `@`, and for the same reason: which
 * half-typed token the caret is inside is easy to get subtly wrong and should
 * be testable without a browser.
 */

export type ReferenceCandidate = {
  kind: 'project' | 'subject' | 'conversation';
  id: string;
  name: string;
  /** "imported from ChatGPT", where that is true. */
  note?: string;
};

export type ReferencesResponse = { items: ReferenceCandidate[] };

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What to offer for the half-typed name.
 *
 * The picker is deliberately more forgiving than the resolver: here a
 * substring match helps you FIND the thing, and you then pick it, so a loose
 * match costs a glance. The resolver stays strict because there nobody is
 * looking — a loose match would silently hand over the wrong project.
 *
 * Projects, then subjects, then conversations: the same order the picker's
 * headings imply, and the most grounded thing first.
 */
export function candidatesMatching(items: ReferenceCandidate[], query: string): ReferenceCandidate[] {
  const q = normalise(query);
  const rank = { project: 0, subject: 1, conversation: 2 } as const;
  return items
    .filter((item) => q === '' || normalise(item.name).includes(q) || normalise(item.id).includes(q))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

/**
 * What this send is about to read, said before it is pressed — the same
 * principle as the agent roster's price tag: the cost of a decision belongs in
 * front of it, not on the receipt.
 */
export function referenceNote(text: string, items: ReferenceCandidate[]): string | null {
  const names = referencedNames(text);
  if (names.length === 0) return null;
  const found = names.map((name) => {
    const hit = items.find((i) => normalise(i.name) === normalise(name) || normalise(i.name).startsWith(normalise(name)));
    return hit ? `${hit.name}${hit.note ? ` (${hit.note})` : ''}` : `"${name}" — nothing by that name`;
  });
  return `Reading ${found.join(', ')} alongside this.`;
}
