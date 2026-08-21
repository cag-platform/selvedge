/**
 * A coding session that happened somewhere Selvedge wasn't — in a terminal, on
 * the owner's own machine — reduced to what can honestly be said about it
 * afterwards.
 *
 * THE SHAPE IS THE PRIVACY PROMISE. There is no field here for a transcript, a
 * diff, or a file's contents, and there must never be one: the companion reads
 * whole session logs on the machine they live on and sends only this. Everything
 * in it is either a fact about the session (when, where, which tool) or a
 * bounded summary (the first ask, the file paths, the tool counts). If a future
 * field can't be defended on those terms, it doesn't belong.
 */

export type SessionAgent = 'claude-code' | 'codex';

/**
 * How a session ended, as far as anyone can tell from outside:
 *   shipped    — a commit landed in the repo while it was open
 *   ended      — it finished with work done, and nothing was committed
 *   abandoned  — it was opened and effectively nothing happened
 *   error      — the tool itself reported a failure
 *   unreadable — the companion could not parse the log. Reported ON PURPOSE:
 *                a session it can't read must be said out loud, never dropped.
 */
export type SessionOutcome = 'shipped' | 'ended' | 'abandoned' | 'error' | 'unreadable';

export type SessionSummary = {
  agent: SessionAgent;
  /** The tool's own session id — the key a re-sent summary updates on. */
  session_id: string;
  started_at?: string;
  ended_at?: string;
  /** Where it ran, and which repo that directory is — how it finds its project. */
  cwd?: string;
  repo?: string;
  /** The first thing the owner asked for, bounded. Not the conversation. */
  intent?: string;
  files_touched?: string[];
  tools_run?: Record<string, number>;
  outcome: SessionOutcome;
  commit_sha?: string;
  cost_usd?: number;
  /** Why a session couldn't be read, when outcome is 'unreadable'. */
  detail?: string;
};

/** Bounds — a summary that grows without limit stops being a summary. */
export const MAX_INTENT_CHARS = 500;
export const MAX_FILES = 200;
export const MAX_TOOL_KINDS = 50;
export const MAX_DETAIL_CHARS = 500;

const AGENTS: readonly string[] = ['claude-code', 'codex'];
const OUTCOMES: readonly string[] = ['shipped', 'ended', 'abandoned', 'error', 'unreadable'];

export type SummaryCheck = { ok: true; value: SessionSummary } | { ok: false; error: string };

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

/**
 * Validate and BOUND one summary. Pure, shared by the companion (before it
 * sends) and the server (before it stores), so the two can never disagree about
 * what a legal summary is — and so the bounds are applied on the machine that
 * holds the data as well as the one that receives it.
 */
export function checkSessionSummary(input: unknown): SummaryCheck {
  const body = input as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return { ok: false, error: 'a session summary must be an object' };

  const agent = body.agent;
  if (typeof agent !== 'string' || !AGENTS.includes(agent)) {
    return { ok: false, error: `agent must be one of ${AGENTS.join(', ')}` };
  }
  const sessionId = str(body.session_id, 200);
  if (!sessionId) return { ok: false, error: 'a session summary needs the session id it belongs to' };
  const outcome = body.outcome;
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) {
    return { ok: false, error: `outcome must be one of ${OUTCOMES.join(', ')}` };
  }

  const files = Array.isArray(body.files_touched)
    ? body.files_touched.filter((f): f is string => typeof f === 'string' && f.trim() !== '').slice(0, MAX_FILES)
    : undefined;

  let tools: Record<string, number> | undefined;
  if (body.tools_run && typeof body.tools_run === 'object' && !Array.isArray(body.tools_run)) {
    tools = {};
    for (const [name, count] of Object.entries(body.tools_run as Record<string, unknown>).slice(0, MAX_TOOL_KINDS)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) tools[name.slice(0, 60)] = Math.round(count);
    }
  }

  const cost = typeof body.cost_usd === 'number' && Number.isFinite(body.cost_usd) && body.cost_usd >= 0 ? body.cost_usd : undefined;

  return {
    ok: true,
    value: {
      agent: agent as SessionAgent,
      session_id: sessionId,
      outcome: outcome as SessionOutcome,
      ...(str(body.started_at, 40) ? { started_at: str(body.started_at, 40)! } : {}),
      ...(str(body.ended_at, 40) ? { ended_at: str(body.ended_at, 40)! } : {}),
      ...(str(body.cwd, 400) ? { cwd: str(body.cwd, 400)! } : {}),
      ...(str(body.repo, 200) ? { repo: str(body.repo, 200)! } : {}),
      ...(str(body.intent, MAX_INTENT_CHARS) ? { intent: str(body.intent, MAX_INTENT_CHARS)! } : {}),
      ...(files?.length ? { files_touched: files } : {}),
      ...(tools && Object.keys(tools).length ? { tools_run: tools } : {}),
      ...(str(body.commit_sha, 40) ? { commit_sha: str(body.commit_sha, 40)! } : {}),
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(str(body.detail, MAX_DETAIL_CHARS) ? { detail: str(body.detail, MAX_DETAIL_CHARS)! } : {}),
    },
  };
}
