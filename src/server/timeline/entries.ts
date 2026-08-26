import type { CardState, CardVerdict } from '../cards/types.js';
import type { DeepLinkDestination } from '../../shared/types/continuation.js';

/**
 * THE TIMELINE'S VOCABULARY — one plain sentence per thing that happened, and
 * the edge that says what it meant.
 *
 * The record already existed: cards, runs, narrations, threads, verdicts. What
 * it never had was a face. Everything here is a pure function from a row that
 * is already in the database to a sentence a person can read, so the timeline
 * cannot invent — if a fact isn't in the record, no sentence is written for it,
 * and nothing here calls a model.
 *
 * The status is the same four-value edge vocabulary the rest of the product
 * uses, applied to history rather than to a project:
 *   needs    — this needed you, or still does (a break, a card waiting, work
 *              that didn't do what was asked)
 *   working  — motion: a ship, an undo, a handover, a conversation starting
 *   healthy  — it turned out fine and something checked
 *   unknown  — dashed, shape-distinct: nobody could tell. Never "fine".
 */

export type TimelineStatus = 'healthy' | 'working' | 'needs' | 'unknown';
export type TimelineKind = 'ask' | 'verdict' | 'thread' | 'evidence' | 'ship' | 'undo' | 'switch' | 'event' | 'session';

export type TimelineEntry = {
  id: string;
  /** ISO timestamp — the timeline is ordered on this, newest first. */
  at: string;
  kind: TimelineKind;
  /** One plain sentence. This is the whole line a person reads. */
  sentence: string;
  status: TimelineStatus;
  /** What the sentence rests on, shown when the entry is opened. Never a claim the sentence didn't make. */
  evidence: string[];
  ref: { thread_id?: string; card_id?: string; run_id?: string; commit?: string; event_id?: string };
  destination?: DeepLinkDestination;
};

function trim(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function money(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined || cents <= 0) return null;
  return cents < 100 ? `${cents}c` : `$${(cents / 100).toFixed(2)}`;
}

/** A card that is still open needs you (or is in motion); a finished one is judged by its verdict. */
export function cardStatus(state: CardState, verdict: CardVerdict | null): TimelineStatus {
  if (state === 'proposed' || state === 'blocked') return 'needs';
  if (state === 'approved' || state === 'working' || state === 'verifying') return 'working';
  if (state === 'done') return verdict === 'verified' ? 'healthy' : 'unknown';
  if (state === 'failed') return 'needs';
  return 'unknown'; // declined, stopped — closed without a clean result
}

export type CardRow = {
  id: string;
  title: string;
  proposal: string;
  trigger: string;
  risk: string;
  gate: string;
  state: CardState;
  verdict: CardVerdict | null;
  gradedBy: string | null;
  spentCents: number;
  createdAt: Date;
  updatedAt: Date;
};

/** "You asked for X" — or, when Selvedge started it itself, that it did. */
export function askEntry(card: CardRow): TimelineEntry {
  const asked = card.trigger === 'request' ? 'You asked for' : 'Something broke, so I proposed';
  return {
    id: `ask:${card.id}`,
    at: card.createdAt.toISOString(),
    kind: 'ask',
    sentence: `${asked}: ${trim(card.title)}`,
    status: cardStatus(card.state, card.verdict),
    evidence: [
      card.proposal,
      `${card.risk} change, ${card.gate === 'hard' ? 'needs a confirmed backup before it can ship' : `${card.gate} gate`}`,
    ].filter(Boolean),
    ref: { card_id: card.id },
  };
}

const VERDICT_SENTENCE: Record<CardVerdict, string> = {
  verified: 'it did what you asked, and a different model than wrote it checked',
  probably: 'it looks right, but nothing independent checked it',
  inconclusive: "I couldn't tell whether it did what you asked",
  didnt_work: "it didn't do what you asked",
  stopped: 'it stopped at the cap you set',
};

/** How a piece of work turned out. Only for work that actually finished. */
export function verdictEntry(card: CardRow): TimelineEntry | null {
  if (!['done', 'failed', 'stopped', 'declined'].includes(card.state)) return null;
  if (card.state === 'declined') {
    return {
      id: `verdict:${card.id}`,
      at: card.updatedAt.toISOString(),
      kind: 'verdict',
      sentence: `You turned down: ${trim(card.title)}`,
      status: 'unknown',
      evidence: ['Nothing was built, and nothing was spent.'],
      ref: { card_id: card.id },
    };
  }
  const verdict = card.verdict;
  const tail = verdict ? VERDICT_SENTENCE[verdict] : 'it ended without a verdict';
  const spent = money(card.spentCents);
  return {
    id: `verdict:${card.id}`,
    at: card.updatedAt.toISOString(),
    kind: 'verdict',
    sentence: `${trim(card.title)} — ${tail}.`,
    status: cardStatus(card.state, verdict),
    evidence: [
      ...(spent ? [`Cost ${spent}.`] : []),
      ...(card.gradedBy === 'independent' ? ['Checked by a different model than the one that wrote it.'] : []),
      ...(card.gradedBy === 'ungraded' ? ['No independent check ran, so this verdict tops out at "probably".'] : []),
    ],
    ref: { card_id: card.id },
  };
}

export type ThreadRow = { id: string; title: string; kind: string; agent: string; createdAt: Date };

export function threadEntry(thread: ThreadRow): TimelineEntry {
  return {
    id: `thread:${thread.id}`,
    at: thread.createdAt.toISOString(),
    kind: 'thread',
    sentence: thread.kind === 'workshop' ? `A piece of work started: ${trim(thread.title)}` : `A conversation started: ${trim(thread.title)}`,
    status: 'working',
    evidence: [thread.kind === 'workshop' ? 'Builds in the project sandbox.' : 'Plain chat — nothing is built in it.'],
    ref: { thread_id: thread.id },
  };
}

export type RunRow = {
  id: string;
  threadId: string | null;
  prompt: string;
  status: string;
  agent: string | null;
  commitSha: string | null;
  costCents: number | null;
  changedPaths: string[] | null;
  createdAt: Date;
  evidence?: { summary: string; explanation: string; status: 'healthy' | 'unknown' | 'needs' };
};

/** A ship, an undo — the two moments a project's real world changed. */
export function runEntry(run: RunRow): TimelineEntry | null {
  const isShip = run.prompt.startsWith('ship:');
  const isUndo = run.prompt.startsWith('undo:');
  if (!isShip && !isUndo) {
    if (run.prompt.startsWith('plan:') || run.status === 'queued' || run.status === 'running' || !run.evidence) return null;
    const files = run.changedPaths ?? [];
    return {
      id: `evidence:${run.id}`,
      at: run.createdAt.toISOString(),
      kind: 'evidence',
      sentence: `${trim(run.prompt)} — ${run.evidence.summary}.`,
      status: run.evidence.status,
      evidence: [run.evidence.explanation, files.length ? `${files.length} changed file${files.length === 1 ? '' : 's'} recorded.` : 'No changed-file list was recorded.'],
      ref: { run_id: run.id, ...(run.threadId ? { thread_id: run.threadId } : {}) },
    };
  }

  const files = run.changedPaths ?? [];
  const shortCommit = run.commitSha ? run.commitSha.slice(0, 7) : null;
  const summary = run.prompt.replace(/^(ship|undo):\s*/, '');

  if (isUndo) {
    return {
      id: `run:${run.id}`,
      at: run.createdAt.toISOString(),
      kind: 'undo',
      sentence: `A ship was undone${shortCommit ? ` (${shortCommit})` : ''}.`,
      status: 'working',
      evidence: ['A real revert, pushed the same way the change was — nothing was force-pushed.'],
      ref: { run_id: run.id, ...(run.threadId ? { thread_id: run.threadId } : {}), ...(run.commitSha ? { commit: run.commitSha } : {}) },
    };
  }

  const fileNote =
    files.length === 0
      ? 'The changed files weren\'t recorded on this ship.'
      : files.length === 1
        ? `One file changed: ${files[0]}.`
        : `${files.length} files changed, including ${files.slice(0, 3).join(', ')}.`;
  return {
    id: `run:${run.id}`,
    at: run.createdAt.toISOString(),
    kind: 'ship',
    sentence: `Shipped: ${trim(summary)}`,
    status: 'working',
    evidence: [fileNote, ...(shortCommit ? [`Commit ${shortCommit}.`] : [])],
    ref: { run_id: run.id, ...(run.threadId ? { thread_id: run.threadId } : {}), ...(run.commitSha ? { commit: run.commitSha } : {}) },
  };
}

export type SwitchRow = {
  id: string;
  threadId: string | null;
  content: string;
  createdAt: Date;
  meta: { switch?: { from?: string; to?: string; tokens?: number; cost_usd?: number | null } } | null;
};

/** Who took the work over, and what carrying the context cost. */
export function switchEntry(row: SwitchRow, nameOf: (agent: string) => string): TimelineEntry {
  const from = row.meta?.switch?.from;
  const to = row.meta?.switch?.to;
  const tokens = row.meta?.switch?.tokens ?? 0;
  return {
    id: `switch:${row.id}`,
    at: row.createdAt.toISOString(),
    kind: 'switch',
    sentence:
      from && to
        ? `The work passed from ${nameOf(from)} to ${nameOf(to)} mid-thread${tokens > 0 ? ', carrying what had happened so far' : ''}.`
        : 'The work passed to another agent mid-thread.',
    status: 'working',
    // The line the thread itself shows, kept verbatim: it states the real size
    // and price of the handover, and the timeline must not soften it.
    evidence: [row.content],
    ref: { ...(row.threadId ? { thread_id: row.threadId } : {}) },
  };
}

export type NarrationRow = {
  id: string;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  fragment: string | null;
  technicalDetail: string | null;
  verdict: string | null;
  confidence: string | null;
  kind: string | null;
  /** The correlation and, when the commits named one, the work behind it. */
  meta?: {
    correlation?: { plain?: string };
    fusion?: {
      sentence?: string;
      ambiguous?: boolean;
      attributions?: Array<{ kind?: string; threadId?: string; commit?: string | null }>;
    };
  } | null;
};

/** What the watching saw: a deploy, a break, a fix — in the words the brief used. */
export function eventEntry(row: NarrationRow): TimelineEntry | null {
  if (!row.fragment) return null; // a silent narration said nothing; the timeline says nothing either
  const status: TimelineStatus =
    row.verdict === 'users_affected' ? 'needs' : row.verdict === 'users_fine' ? 'healthy' : row.verdict === 'cannot_tell' ? 'unknown' : 'working';
  // The fused sentence joins the entry itself, not its evidence: "this began
  // after the change from Monday's Codex session" is the point of the line, not
  // a footnote to it. The correlation stays in the evidence beneath, where it
  // has always been.
  const fused = row.meta?.fusion?.sentence;
  const attributions = row.meta?.fusion?.attributions ?? [];
  const only = !row.meta?.fusion?.ambiguous && attributions.length === 1 ? attributions[0] : null;
  return {
    id: `event:${row.id}`,
    at: row.occurredAt.toISOString(),
    kind: 'event',
    sentence: `${trim(row.fragment, 220)}${fused ? ` ${fused}` : ''}`,
    status,
    evidence: [
      ...(row.technicalDetail ? [row.technicalDetail] : []),
      ...(row.meta?.correlation?.plain ? [row.meta.correlation.plain] : []),
      `${row.eventType}${row.confidence ? ` · ${row.confidence} confidence` : ''}`,
    ],
    // When the sentence names ONE session, the entry carries the way to it:
    // the conversation to open and the commit to read. Named several, it links
    // to none of them — sending someone to one of three suspects would be the
    // pick the sentence just refused to make.
    ref: {
      event_id: row.eventId,
      ...(only ? { ...(only.threadId ? { thread_id: only.threadId } : {}), ...(only.commit ? { commit: only.commit } : {}) } : {}),
    },
  };
}

export type SessionRow = {
  id: string;
  agent: string;
  sessionId: string;
  intent: string | null;
  filesTouched: string[] | null;
  toolsRun: Record<string, number> | null;
  outcome: string;
  commitSha: string | null;
  costUsd: number | null;
  detail: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
};

/**
 * A session that happened somewhere else — in a terminal, in a tool Selvedge
 * doesn't run.
 *
 * MARKED, ALWAYS. Every one of these sentences says "outside Selvedge" and
 * every one of them carries the same evidence line, because the difference
 * between work Selvedge gated and work it merely heard about is the difference
 * between a verdict and a rumour. Nothing here may ever say verified, checked,
 * or held up — it wasn't watched, and pretending otherwise is the one
 * unforgivable output wearing a new hat.
 */
export function sessionEntry(row: SessionRow, nameOf: (agent: string) => string): TimelineEntry {
  const at = (row.endedAt ?? row.startedAt ?? row.createdAt).toISOString();
  const tool = nameOf(row.agent);

  if (row.outcome === 'unreadable') {
    return {
      id: `session:${row.id}`,
      at,
      kind: 'session',
      sentence: `I couldn't read a ${tool} session from outside Selvedge, so I can't tell you what happened in it.`,
      status: 'unknown',
      evidence: [row.detail ?? 'The session log was in a shape the companion did not recognise.', OBSERVED_NOTE],
      ref: {},
    };
  }

  const files = row.filesTouched ?? [];
  const tail =
    row.outcome === 'shipped'
      ? `, and a commit landed${row.commitSha ? ` (${row.commitSha.slice(0, 7)})` : ''}`
      : row.outcome === 'abandoned'
        ? ', and nothing came of it'
        : row.outcome === 'error'
          ? ', and it ended in an error'
          : ', with nothing committed';
  return {
    id: `session:${row.id}`,
    at,
    kind: 'session',
    sentence: `A ${tool} session ran here outside Selvedge${row.intent ? ` — "${trim(row.intent, 120)}"` : ''}${tail}.`,
    // Motion, never health: this work was not gated or verified here.
    status: row.outcome === 'error' ? 'unknown' : 'working',
    evidence: [
      ...(files.length ? [`Files touched: ${files.slice(0, 8).join(', ')}${files.length > 8 ? `, and ${files.length - 8} more` : ''}.`] : []),
      ...(row.toolsRun && Object.keys(row.toolsRun).length
        ? [`Ran: ${Object.entries(row.toolsRun).map(([name, n]) => `${name} ×${n}`).join(', ')}.`]
        : []),
      ...(row.costUsd ? [`It reported costing about $${row.costUsd.toFixed(2)}.`] : []),
      OBSERVED_NOTE,
    ],
    ref: { ...(row.commitSha ? { commit: row.commitSha } : {}) },
  };
}

/** The mark that must ride on every observed session, everywhere it is shown. */
export const OBSERVED_NOTE =
  'Observed from outside: Selvedge did not run this work, did not gate it, and has not checked whether it held up.';

/** Newest first, and stable: two things in the same second keep a fixed order. */
export function orderTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
