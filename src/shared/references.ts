/**
 * #-REFERENCES — bringing another conversation into this one, in the sentence
 * where you were already thinking about it.
 *
 * "how does #loom handle refunds?" is one thought. Naming the other thing is
 * how people talk about it, so that is where naming it belongs — not in a
 * picker, a sidebar, or a mode entered before the sentence starts.
 *
 * A SEPARATE SIGIL FROM @, ON PURPOSE. `@` chooses WHO ANSWERS; `#` chooses
 * WHAT WE ARE TALKING ABOUT. Two questions, two marks. Folding projects into
 * the `@` namespace would also have been a trap with a fuse on it: name a
 * project "codex" and `@codex` becomes permanently ambiguous between an agent
 * and a place, with no honest way to pick.
 *
 * WHAT CAN BE REFERENCED is deliberately wide: a project, a subject, or one
 * conversation — including a ChatGPT or Claude export that was imported. Those
 * arrive as ordinary threads, so a chat you had somewhere else last March is
 * the same kind of thing as the one you are in now, and can be pointed at the
 * same way.
 *
 * THE PARSE IS THE SERVER'S, exactly as it is for mentions. The client parses
 * too — it has to, to show what it is about to pull in — but what actually
 * happens is decided from the stored text, the only version nobody can edit
 * after the fact.
 */

/**
 * A reference starts a word, so a `#` inside a URL fragment, a CSS colour, or
 * an issue number written mid-sentence donates nothing to anybody.
 *
 * Two shapes: bare for a single word, quoted for anything with spaces in it —
 * an imported conversation is usually called something like "diabetes app
 * ideas", and requiring people to rename their own history before they can
 * point at it would be absurd.
 */
const REFERENCE = /(^|[^A-Za-z0-9_])#(?:"([^"\n]{1,120})"|([A-Za-z0-9_-]+))/g;

/**
 * How many things one message may name.
 *
 * Raised from three, which was a number I picked rather than justified. A
 * question that genuinely spans four projects is a real question, and refusing
 * the fourth silently — the parser just stops — is the worst way to hold a
 * limit.
 */
export const MAX_REFERENCES = 6;

/**
 * Every name referenced in this message, in the order they were written,
 * without repeats. Case is preserved — these are matched against titles people
 * chose, and lowercasing them here would make the echo look wrong.
 *
 * Nothing is resolved at this layer: this only reports what was TYPED. Whether
 * a name means anything is a question about one org's data, which belongs on
 * the server with the database in front of it.
 */
export function referencedNames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const name = (match[2] ?? match[3] ?? '').trim();
    if (name === '') continue;
    if (found.some((seen) => seen.toLowerCase() === name.toLowerCase())) continue;
    found.push(name);
    if (found.length === MAX_REFERENCES) break;
  }
  return found;
}

/** Whether a message points at anything at all. */
export function hasReference(text: string): boolean {
  return referencedNames(text).length > 0;
}

/**
 * The reference being typed right now, for the picker — the text between a
 * trailing `#` and the caret. Null when the caret isn't in one.
 *
 * Mirrors mentionQuery's job on the `@` side: an empty string means the `#`
 * was just typed and everything should be offered, which is different from
 * null (not referencing anything) and must not be collapsed into it.
 */
export function referenceQuery(text: string): string | null {
  const open = /(?:^|[^A-Za-z0-9_])#("?)([^"\n]*)$/.exec(text);
  if (!open) return null;
  return open[2] ?? '';
}

/**
 * Replace the reference being typed with a chosen name, quoting it when it has
 * spaces. Returns the whole new message, because the composer holds one string
 * and a caller reassembling it from pieces is a caller with an off-by-one.
 */
export function completeReference(text: string, name: string): string {
  const open = /(?:^|[^A-Za-z0-9_])#("?)([^"\n]*)$/.exec(text);
  if (!open) return text;
  const written = /[\s"]/.test(name) ? `#"${name.replace(/"/g, '')}"` : `#${name}`;
  // The match may carry one leading separator character; the `#` is at its
  // start or one past it, never further, because the prefix group matches a
  // single character.
  const hash = open.index + (open[0].startsWith('#') ? 0 : 1);
  return `${text.slice(0, hash)}${written} `;
}

/**
 * How a resolved reference is described back to the owner — one line in the
 * conversation saying what was brought in, so context arriving is visible
 * rather than something the answer just mysteriously knows.
 *
 * An imported conversation says so IN THIS LINE, not only in its own record.
 * "You told ChatGPT in March that refunds reverse the original charge" is
 * worth knowing and is not the same as having decided it here; a reference
 * that quietly launders the one into the other is the false-calm rule wearing
 * a different coat.
 */
export function referenceLine(brought: Array<{ label: string; note?: string; found?: boolean }>): string {
  const say = (b: { label: string; note?: string }) => (b.note ? `${b.label} (${b.note})` : b.label);
  const join = (parts: string[]) => (parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

  const named = brought.filter((b) => !b.found).map(say);
  const found = brought.filter((b) => b.found).map(say);

  const parts: string[] = [];
  if (named.length) parts.push(`reading ${join(named)}`);
  // A GUESS SAYS SO. The database found these from what was asked; presenting
  // that as though it had been chosen is how somebody ends up believing they
  // pointed at something they never did.
  if (found.length) parts.push(`${named.length ? 'and ' : ''}looked back at ${join(found)}, which seemed to be what you meant`);

  return `⇄ ${parts.join(' ')} — nothing there was changed.`;
}
