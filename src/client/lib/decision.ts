/**
 * THE DECISION BRIEF, on the wire — and the one rule about it that lives here
 * rather than in a component: a brief and its dating travel together.
 *
 * The server never hands out a bare brief (decisions/store.ts, withFreshness),
 * so the client type has no shape in which one can exist. If a component only
 * has a `DecisionBrief`, it cannot render — it needs the `DatedBrief`, and the
 * dating is what it is required to show.
 */

export type DecisionBrief = {
  id: string;
  title: string;
  decision: string;
  why: string | null;
  constraints: string[];
  openQuestions: string[];
  projectId: string | null;
  thinkingThreadId: string;
  buildingThreadId: string | null;
  editedByHuman: boolean;
  evidenceThrough: string | null;
  evidenceMessages: number;
};

export type Freshness = {
  state: 'current' | 'stale';
  behind: number;
  note: string;
};

export type DatedBrief = {
  brief: DecisionBrief;
  freshness: Freshness;
  thinkingMessages: number;
};

/** GET /api/threads/:id/decision — null when this thread has never decided anything. */
export type DecisionResponse = { brief: null } | DatedBrief;

export function hasBrief(res: DecisionResponse | null): res is DatedBrief {
  return res !== null && res.brief !== null;
}

/**
 * What the 409 from the message path carries when a building thread is about to
 * work from a decision the thinking has moved past.
 */
export type StaleRefusal = {
  brief_id: string;
  behind: number;
  thinking_thread_id: string;
};

export function staleRefusalOf(body: Record<string, unknown>): StaleRefusal | null {
  const stale = body.stale_decision as Partial<StaleRefusal> | undefined;
  if (!stale || typeof stale.brief_id !== 'string' || typeof stale.behind !== 'number') return null;
  return {
    brief_id: stale.brief_id,
    behind: stale.behind,
    thinking_thread_id: typeof stale.thinking_thread_id === 'string' ? stale.thinking_thread_id : '',
  };
}

/**
 * The dating line, in words, for a person rather than an agent.
 *
 * The `evidenceMessages` half matters as much as the staleness: "written from
 * 12 messages" is what makes "3 since" mean something. A brief made from
 * nothing says so plainly rather than looking merely current.
 */
export function datingLine(dated: DatedBrief): string {
  const from =
    dated.brief.evidenceMessages === 0
      ? 'Written from nothing on the record'
      : `Written from ${dated.brief.evidenceMessages} message${dated.brief.evidenceMessages === 1 ? '' : 's'} of the thinking`;
  const since =
    dated.freshness.state === 'current'
      ? 'nothing said since'
      : `${dated.freshness.behind} said since`;
  return `${from} · ${since}`;
}
