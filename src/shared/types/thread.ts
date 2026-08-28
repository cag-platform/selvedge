/**
 * A thread is the unit of work. One project holds many: coding conversations
 * that run in a sandbox, and plain chat that never touches one.
 *
 * Before threads, a project had exactly one conversation — the Workshop's — and
 * "which conversation" was never a question anyone could ask. Migration 0022
 * turns that single conversation into thread #1 of its project, and everything
 * written to a thread afterwards names the thread it belongs to.
 *
 * The two kinds are a real difference in machinery, not a label:
 *   workshop — runs a coding agent inside the project's Development Workspace; can
 *              stage changes, ship them, and be undone.
 *   general  — direct model calls, no sandbox, nothing to ship. Where the
 *              thinking happens before there is anything to build.
 */
export type ThreadKind = 'workshop' | 'general';

export const THREAD_KINDS: readonly ThreadKind[] = ['workshop', 'general'];

export function isThreadKind(value: unknown): value is ThreadKind {
  return typeof value === 'string' && (THREAD_KINDS as readonly string[]).includes(value);
}

/** What the first workshop thread of a project is called until someone renames it. */
export const DEFAULT_WORKSHOP_TITLE = 'Workshop';
/** What a fresh general thread is called until it earns a name. */
export const DEFAULT_GENERAL_TITLE = 'New thread';

/**
 * Where a half-formed thing lives before it is anything.
 *
 * A constant rather than a literal in two places: the server makes this subject
 * on first use and both clients look for it by name to decide whether the
 * "Start an idea" door leads somewhere that already exists. One string, three
 * readers — the same reason the plan table is shared.
 */
export const IDEAS_SUBJECT = 'Ideas';
