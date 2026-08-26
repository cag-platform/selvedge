import type { RunRecordView } from './replay.js';
import type { TechnicalDetail } from '../../shared/technicalDetail.js';

/**
 * The Inbox's wire shapes, in one place — what /api/inbox and /api/threads/:id
 * actually return. Kept beside the pure helpers that shape them for the rail,
 * so the ordering rules the workbench depends on are testable without a browser.
 */

export type ThreadRow = {
  id: string;
  kind: 'workshop' | 'general';
  title: string;
  agent: string;
  /** The agent's mono mark, resolved server-side so an unknown agent still shows something. */
  chip: string;
  working: boolean;
  last_at: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  /** Null when nothing has ever reported — see the server's hasHealthSignal. */
  status: 'healthy' | 'working' | 'needs' | 'unknown' | null;
  health: string | null;
  threads: ThreadRow[];
  /** Folded out of the rail by the owner — see shared/putAway.ts. */
  put_away?: boolean;
};

/** A subject: conversations that belong to a topic rather than to a codebase. */
export type SubjectRow = {
  id: string;
  name: string;
  threads: ThreadRow[];
  /** Folded out of the rail by the owner — see shared/putAway.ts. */
  put_away?: boolean;
};

export type InboxData = {
  projects: ProjectRow[];
  subjects: SubjectRow[];
  engine_on: boolean;
};

export type ThreadMessage = {
  id: string;
  role: 'owner' | 'agent' | 'activity' | 'switch';
  content: string;
  at: string;
  attachments: Array<{ id: string; mime: string }>;
  run_id?: string | null;
  /** Which agent gave this answer, when it wasn't the thread's own. Set on
   *  every reply to a consultation — asking two agents is pointless if both
   *  answers come back signed the same way. */
  answered_by?: string | null;
  /** Stable identity for a parallel consultation; never inferred from order. */
  consultation_id?: string | null;
  /** The one owner message every answer in that consultation responds to. */
  in_reply_to?: string | null;
  /** Pastes attached to this message — name and size only; the text is one request away. */
  documents?: Array<{ index: number; name: string; chars: number }>;
  meta?:
    | RunRecordView
    | { switch?: { from: string; to: string; tokens: number; cost_usd: number | null; receipt_id?: string } }
    | {
        consulted?: string[];
        skipped?: string[];
        consultation_id?: string;
        in_reply_to?: string;
        consultation?: { id: string; prompt_id: string; agents: string[] };
      }
    | null;
};

export type ThreadRun = {
  id: string;
  status: string;
  cost_cents: number | null;
  commit: string | null;
  kind: 'ship' | 'turn' | 'undo' | 'plan';
  at: string;
  agent?: string | null;
  model?: string | null;
  changed_paths?: string[] | null;
  evidence?: { outcome: string; status: 'healthy' | 'unknown' | 'needs'; summary: string; explanation: string; path: string };
};

export type ConsoleLink = { provider: string; label: string; url: string };
export type GeneratedVisual = {
  id: string;
  message_id: string | null;
  consultation_id: string | null;
  directing_agent: string;
  rendering_provider: string;
  rendering_model: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  direction_ms: number | null;
  render_ms: number | null;
  storage_ms: number | null;
  error: string | null;
  parent_id: string | null;
  content_url?: string;
};

export type ThreadData = {
  thread: { id: string; kind: 'workshop' | 'general'; title: string; agent: string; model: string | null; created_at: string; archived: boolean };
  /** One of these is set: a thread is about a project, or about a subject. */
  project: { id: string; name: string } | null;
  subject: { id: string; name: string } | null;
  live_url: string | null;
  /**
   * The accounts behind this project — Railway variables, the Neon console,
   * the repo — as one-click doors. BUILT ON THE SERVER (connectors/consoles.ts)
   * so the phone and the web render identical strings; the client only ever
   * opens them. Absent from older payloads.
   */
  console_links?: ConsoleLink[];
  engine_on: boolean;
  working: boolean;
  staged_changes_ready: boolean;
  sandbox: 'attached' | 'none';
  handoff_waiting: boolean;
  cost_cents: number;
  /** Null means the conversation follows the account-level preference. */
  technical_detail: TechnicalDetail | null;
  effective_technical_detail: TechnicalDetail;
  messages: ThreadMessage[];
  visuals: GeneratedVisual[];
  runs: ThreadRun[];
};

/** Every thread in the rail, flattened with its project — what the palette searches. */
export function allThreads(data: InboxData | null): Array<ThreadRow & { projectId: string; projectName: string }> {
  return [
    ...(data?.projects ?? []).flatMap((p) => p.threads.map((t) => ({ ...t, projectId: p.id, projectName: p.name }))),
    // Subject threads are jumpable too — they are conversations like any other,
    // and the palette should not pretend they aren't there.
    ...(data?.subjects ?? []).flatMap((s) => s.threads.map((t) => ({ ...t, projectId: s.id, projectName: s.name }))),
  ];
}

/**
 * WHERE YOU WERE LAST, NOT WHAT IS SHOUTING LOUDEST.
 *
 * The rail used to sort by the edge vocabulary — needs you, then in motion,
 * then quiet — because the product's question was "what needs me this
 * morning?". That is not the question any more. This is where somebody keeps
 * everything they are building, and the thing you want when you open it is the
 * thing you were last doing.
 *
 * Health-first also degraded badly in practice: most places have never
 * reported anything, so they all landed in one rank and the list collapsed
 * into alphabetical order — a directory of names with no sense of what was
 * live. Recency can't collapse like that, because every place you have
 * actually used has a different last-activity.
 *
 * A PLACE WITH NO CONVERSATION HAS NO RECENCY, so those go last, alphabetically
 * — there is nothing to be recent about, and putting them first would rank a
 * repo nobody has opened above the one open in the next tab.
 *
 * WHAT THIS COSTS, SAID OUT LOUD: a project that broke a month ago now sits
 * where a month-old project sits, rather than being lifted to the top. The edge
 * is still on its row, so the signal is not lost — but the order no longer
 * carries it. That is the trade the change makes, and it is the right one for
 * a workbench and would be the wrong one for a monitor.
 */
export function byRecency<T extends { name: string; chat: { last_at?: string | null } | null }>(places: T[]): T[] {
  const at = (p: T) => p.chat?.last_at ?? '';
  return [...places].sort((a, b) => {
    const [x, y] = [at(a), at(b)];
    if (x && y) return y.localeCompare(x) || a.name.localeCompare(b.name);
    // Never used sinks; two never-used places read alphabetically.
    if (x) return -1;
    if (y) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * ONE LIST, ONE WORD.
 *
 * The rail carried two lists under two headings — "projects" and "subjects" —
 * and the owner had to know which they were in before they could start a
 * conversation. They aren't different things: a subject is a project without a
 * repo. So they are one list, and the only difference is what the rail can
 * honestly SAY about each.
 *
 * A place with no code gets no edge and no health line, because a status on it
 * would be a claim about nothing — the false-calm rule, applied to absence
 * rather than to uncertainty. That is now the ONLY difference between the two:
 * they share one order, by when you were last there. See byRecency.
 */
export type RailPlace = {
  id: string;
  name: string;
  /**
   * Null in two different situations, both of which mean "say nothing": there
   * is no code here to be healthy or broken, or nothing has ever reported on
   * the code that is.
   */
  status: ProjectRow['status'] | null;
  health: string | null;
  threads: ThreadRow[];
  /** Which "new conversation here" this place takes. */
  hasCode: boolean;
  /**
   * THE conversation for this place. One chat per project — the whole point of
   * naming an agent mid-sentence is that a single conversation moves between
   * them, so a list of threads split by agent is the wall we took down, drawn
   * back on in the rail. Null until the first one exists.
   */
  chat: ThreadRow | null;
  /**
   * Folded out of the rail. Still here, still watched, still reachable by `#`
   * — see shared/putAway.ts for why this is a fold rather than a filter.
   */
  putAway: boolean;
};

export function railPlaces(projects: ProjectRow[], subjects: SubjectRow[]): RailPlace[] {
  // ONE LIST, ORDERED BY WHEN YOU WERE THERE — projects and subjects together.
  // They used to be two blocks with every subject below every project, which
  // is the "which of these am I in?" question the merge was supposed to have
  // removed. An idea you were in five minutes ago belongs above a repo you
  // last touched in March, whether or not it has code in it.
  //
  // The server sorts a place's threads newest-first, so the first IS the
  // current conversation.
  const withCode: RailPlace[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    health: p.health,
    threads: p.threads,
    hasCode: true,
    chat: p.threads[0] ?? null,
    putAway: p.put_away === true,
  }));
  const withoutCode: RailPlace[] = subjects.map((s) => ({
    id: s.id,
    name: s.name,
    status: null,
    health: null,
    threads: s.threads,
    hasCode: false,
    chat: s.threads[0] ?? null,
    putAway: s.put_away === true,
  }));
  return byRecency([...withCode, ...withoutCode]);
}

/**
 * The rail, split in two: what is at hand, and what has been folded away.
 *
 * A pure function rather than a filter written inline in the component,
 * because the one property that matters is testable and easy to get wrong —
 * the order inside each half is the order the rail already computed, so
 * bringing something back puts it where it belongs rather than at the end.
 */
export function splitPutAway(places: RailPlace[]): { atHand: RailPlace[]; putAway: RailPlace[] } {
  return {
    atHand: places.filter((p) => !p.putAway),
    putAway: places.filter((p) => p.putAway),
  };
}

/**
 * WHAT A ROW ACTUALLY SAYS, which for most rows was nothing.
 *
 * The second line used to be the health line, and only the health line. A
 * project that has never reported has no health line, so those rows carried a
 * name, a timestamp and a two-letter chip — and since almost nothing reports
 * (a health signal needs a host connector delivering deploy events, or the app
 * to have been put online through Selvedge), that was almost every row. Twelve
 * names in a column with no way to tell one from another without opening it.
 *
 * The conversation's own title is the obvious thing to say and was sitting
 * right there in the payload, unused. "Checkout rework" tells you what that
 * place IS in a way "Loom" never can.
 *
 * HEALTH DROPS TO A THIRD LINE, AND ONLY WHEN IT NEEDS WORDS. The edge already
 * carries the status for every other case — that is what the edge is for — and
 * spending a whole line on "Everything users touch is healthy." to push what
 * you were doing off the row is the wrong trade. `needs` keeps its sentence,
 * because that is the one a colour alone cannot make actionable.
 */
export type PlaceLines = {
  /** The second line: what this place is, in the owner's own words. */
  said: string;
  /** A third line, or nothing. Present only where colour is not enough. */
  note: string | null;
};

export function placeLines(place: Pick<RailPlace, 'chat' | 'health' | 'status'>): PlaceLines {
  return {
    said: place.chat?.title?.trim() || NOTHING_SAID,
    note: place.status === 'needs' && place.health ? place.health : null,
  };
}

/** Said where a place exists but nobody has opened the conversation yet. */
export const NOTHING_SAID = 'Nothing said here yet — open it and start.';

/** A thread's date, said the way a person would in a list. */
export function whenShort(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Filter threads and projects for the jump palette — plain substring, no cleverness. */
export function matches(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return fields.some((f) => f.toLowerCase().includes(q));
}
