/**
 * The commit stamp: `Selvedge-Session: <thread id>`, written as a git trailer
 * on every Workshop ship.
 *
 * Why a trailer, and why now. Selvedge already knows which conversation asked
 * for a change and already knows which commit went out; what it has never had
 * is a join that survives OUTSIDE its own database — in the repo, where git log
 * can read it, where a rebase carries it along, and where an agent working in
 * the terminal weeks later can see who did this and why. Phase 4's whole
 * differentiator ("Tuesday's checkout errors began after the change from
 * Monday's session") is that join. Stamping costs nothing today and makes the
 * join deterministic rather than a guess from timestamps.
 *
 * PURE AND DEPENDENCY-FREE ON PURPOSE. Ship writes the trailer (layer 5); the
 * correlation step will read it (layer 3). A module either of them can import
 * without dragging the other's world along has to owe nothing to either.
 *
 * The value is a Selvedge thread id — the conversation is the session. For work
 * done outside Selvedge the same key will carry the external agent session's
 * id, recorded by the companion daemon; both sides read with parseSessionTrailer.
 */

export const SESSION_TRAILER_KEY = 'Selvedge-Session';

/**
 * Ids we are willing to put in a commit message. Deliberately narrow: a session
 * id is a ulid or a derived token, and anything that isn't shaped like one has
 * no business being interpolated into a shell command and a permanent record.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function isStampableSessionId(sessionId: string): boolean {
  return SAFE_ID.test(sessionId);
}

/** The trailer line itself, or null when the id isn't one we'd stamp. */
export function sessionTrailer(sessionId: string): string | null {
  return isStampableSessionId(sessionId) ? `${SESSION_TRAILER_KEY}: ${sessionId}` : null;
}

/**
 * The commit message a ship writes: the subject people read, then the trailer
 * block. Separated by a blank line, which is what makes it a trailer to git
 * rather than a second line of prose.
 *
 * An unstampable (or absent) id yields the subject alone. A ship that can't be
 * stamped still ships — the stamp is evidence, never a gate.
 */
export function stampedCommitMessage(subject: string, sessionId: string | null | undefined): string {
  const trailer = sessionId ? sessionTrailer(sessionId) : null;
  return trailer ? `${subject}\n\n${trailer}` : subject;
}

/**
 * Read the stamp back off a commit message. Last one wins, matching git's own
 * reading of a repeated trailer key — a revert or a rebase that carries an old
 * message forward must not out-vote the stamp written by the ship in hand.
 *
 * Returns null when there is no stamp, which is the common case and not a
 * problem: an unstamped commit is one Selvedge didn't ship, and Phase 4's rule
 * is that no session in the window means no story invented.
 */
export function parseSessionTrailer(message: string): string | null {
  const pattern = new RegExp(`^\\s*${SESSION_TRAILER_KEY}:[ \\t]*(\\S+)\\s*$`, 'i');
  let found: string | null = null;
  for (const line of message.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match?.[1] && isStampableSessionId(match[1])) found = match[1];
  }
  return found;
}
