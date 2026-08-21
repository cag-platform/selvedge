import { and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { externalSessions } from '../db/schema/index.js';
import { agentById } from '../../shared/agents.js';
import type { ContextPack } from '../../shared/types/pack.js';

/**
 * YESTERDAY, OUTSIDE SELVEDGE — the read half of the loop, arriving where the
 * owner already looks.
 *
 * A day spent in the terminal used to be invisible here: the brief could say
 * what the watching saw and what Selvedge itself did, and nothing at all about
 * the four hours of work that produced it. The companion closes that, and this
 * is the sentence it earns.
 *
 * Two rules, both load-bearing.
 *
 * 1. EVERY LINE SAYS "OUTSIDE SELVEDGE". This work was not gated, not verified,
 *    and not watched. The brief may report it; it may never vouch for it.
 * 2. A SESSION IT COULDN'T READ IS SAID OUT LOUD, and said FIRST. These log
 *    formats are undocumented and change between versions; the failure mode
 *    that matters is a morning where Selvedge quietly narrates two of
 *    yesterday's five sessions and the owner has no idea the other three
 *    existed. Silence about a gap is the one thing the product can't do.
 */

export type SessionForBrief = {
  agent: string;
  projectId: string | null;
  outcome: string;
  intent: string | null;
  detail: string | null;
};

function countWord(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
}

function clip(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The plain lines for a window's observed sessions. Pure, so the phrasing is testable without a database. */
export function externalSessionLines(sessions: SessionForBrief[], packs: ContextPack[]): string[] {
  if (sessions.length === 0) return [];
  const nameOf = (agent: string) => agentById(agent)?.name ?? agent;
  const projectName = (id: string | null) =>
    (id ? packs.find((p) => p.identity.project_id === id)?.identity.name : null) ?? null;

  const lines: string[] = [];

  // The honest failure, first and by itself.
  const unreadable = sessions.filter((s) => s.outcome === 'unreadable');
  if (unreadable.length) {
    const tools = [...new Set(unreadable.map((s) => nameOf(s.agent)))].join(' and ');
    const why = unreadable.find((s) => s.detail)?.detail;
    lines.push(
      `I couldn't read ${countWord(unreadable.length)} of yesterday's ${tools} sessions, so I can't tell you what happened in ${unreadable.length === 1 ? 'it' : 'them'}${why ? ` — ${clip(why, 90)}` : ''}.`,
    );
  }

  const readable = sessions.filter((s) => s.outcome !== 'unreadable');
  if (readable.length === 0) return lines;

  // Grouped by project, because "what happened to Loom yesterday" is the
  // question; sessions that matched no project are their own clause rather
  // than being dropped or filed under a guess.
  const groups = new Map<string, SessionForBrief[]>();
  for (const session of readable) {
    const key = session.projectId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  const clauses: string[] = [];
  for (const [projectId, group] of groups) {
    const tools = [...new Set(group.map((s) => nameOf(s.agent)))].join(' and ');
    const where = projectName(projectId || null) ?? 'a project I could not place';
    const shipped = group.filter((s) => s.outcome === 'shipped');
    const abandoned = group.filter((s) => s.outcome === 'abandoned');
    const errored = group.filter((s) => s.outcome === 'error');
    const ended = group.filter((s) => s.outcome === 'ended');

    // With one session there is nothing to count, and "one — one shipped" reads
    // like a machine talking.
    const only = group.length === 1;
    const count = (n: number) => (only ? '' : `${countWord(n)} `);
    const parts: string[] = [];
    if (shipped.length) {
      const intent = shipped.find((s) => s.intent)?.intent;
      parts.push(`${count(shipped.length)}shipped${intent ? ` (${clip(intent)})` : ''}`);
    }
    if (ended.length) parts.push(`${count(ended.length)}finished without shipping`);
    if (abandoned.length) parts.push(`${count(abandoned.length)}abandoned`);
    if (errored.length) parts.push(`${count(errored.length)}ended in an error`);

    clauses.push(
      `${countWord(group.length)} ${tools} session${group.length === 1 ? '' : 's'} on ${where}${parts.length ? ` — ${parts.join(', ')}` : ''}`,
    );
  }

  lines.push(`Yesterday, outside Selvedge: ${clauses.join('; ')}.`);
  return lines;
}

/** The same lines, read from the window the digest is composing for. */
export async function externalSessionLinesForWindow(
  db: Db,
  orgId: string,
  start: Date,
  end: Date,
  packs: ContextPack[],
): Promise<string[]> {
  const rows = await db
    .select({
      agent: externalSessions.agent,
      projectId: externalSessions.projectId,
      outcome: externalSessions.outcome,
      intent: externalSessions.intent,
      detail: externalSessions.detail,
    })
    .from(externalSessions)
    .where(and(eq(externalSessions.orgId, orgId), gte(externalSessions.createdAt, start), lt(externalSessions.createdAt, end)));
  return externalSessionLines(rows, packs);
}
