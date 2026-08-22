import type { RunRecordView } from './replay.js';

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
  status: 'healthy' | 'working' | 'needs' | 'unknown';
  health: string;
  threads: ThreadRow[];
};

/** A subject: conversations that belong to a topic rather than to a codebase. */
export type SubjectRow = {
  id: string;
  name: string;
  threads: ThreadRow[];
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
  meta?: RunRecordView | { switch?: { from: string; to: string; tokens: number; cost_usd: number | null } } | null;
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
};

export type ThreadData = {
  thread: { id: string; kind: 'workshop' | 'general'; title: string; agent: string; model: string | null; created_at: string; archived: boolean };
  /** One of these is set: a thread is about a project, or about a subject. */
  project: { id: string; name: string } | null;
  subject: { id: string; name: string } | null;
  live_url: string | null;
  engine_on: boolean;
  working: boolean;
  staged_changes_ready: boolean;
  sandbox: 'attached' | 'none';
  handoff_waiting: boolean;
  cost_cents: number;
  messages: ThreadMessage[];
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
 * The rail's own order: projects that need you first, then the ones in motion,
 * then the quiet ones — the edge vocabulary, applied to a list. Within a
 * project the server already sorts threads newest-first.
 */
const RAIL_RANK: Record<ProjectRow['status'], number> = { needs: 0, working: 1, unknown: 2, healthy: 3 };

export function railOrder(projects: ProjectRow[]): ProjectRow[] {
  return [...projects].sort((a, b) => RAIL_RANK[a.status] - RAIL_RANK[b.status] || a.name.localeCompare(b.name));
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
 * rather than to uncertainty. And it sorts after everything that has one: a
 * place that cannot be broken must never outrank one that is.
 */
export type RailPlace = {
  id: string;
  name: string;
  /** Null where there is no code, and therefore nothing that could be healthy. */
  status: ProjectRow['status'] | null;
  health: string | null;
  threads: ThreadRow[];
  /** Which "new conversation here" this place takes. */
  hasCode: boolean;
};

export function railPlaces(projects: ProjectRow[], subjects: SubjectRow[]): RailPlace[] {
  const withCode: RailPlace[] = railOrder(projects).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    health: p.health,
    threads: p.threads,
    hasCode: true,
  }));
  const withoutCode: RailPlace[] = [...subjects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, name: s.name, status: null, health: null, threads: s.threads, hasCode: false }));
  return [...withCode, ...withoutCode];
}

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
