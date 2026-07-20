import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrations, feedback, trustIncidents } from '../db/schema/index.js';

export type TrackRecord = {
  window_days: number;
  narrated: number;
  verdicts: { users_fine: number; users_affected: number; cannot_tell: number; none: number };
  confidence: { high: number; medium: number; low: number; unstated: number };
  feedback: { didnt_help: number; explain_differently: number };
  class1_incidents: number;
  /** Plain-English track record — a product that publishes its own accuracy. */
  summary: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The honesty ledger (Ironclad 2): Selvedge's own calibration, made legible.
 * How often it stated a verdict, how sure it was, how often owners pushed back,
 * and how many all-clears a later signal contradicted (Class-1). This measures
 * Selvedge's honesty, not the user's apps — and no fox-in-henhouse platform
 * will publish its own accuracy.
 */
export async function trackRecord(db: Db, orgId: string, windowDays = 30, now: Date = new Date()): Promise<TrackRecord> {
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const rows = await db
    .select({ verdict: narrations.verdict, confidence: narrations.confidence })
    .from(narrations)
    .where(and(eq(narrations.orgId, orgId), gte(narrations.createdAt, since)));

  const verdicts = { users_fine: 0, users_affected: 0, cannot_tell: 0, none: 0 };
  const confidence = { high: 0, medium: 0, low: 0, unstated: 0 };
  for (const r of rows) {
    if (r.verdict === 'users_fine') verdicts.users_fine++;
    else if (r.verdict === 'users_affected') verdicts.users_affected++;
    else if (r.verdict === 'cannot_tell') verdicts.cannot_tell++;
    else verdicts.none++;

    if (r.confidence === 'high') confidence.high++;
    else if (r.confidence === 'medium') confidence.medium++;
    else if (r.confidence === 'low') confidence.low++;
    else confidence.unstated++;
  }

  const fbRows = await db
    .select({ kind: feedback.kind })
    .from(feedback)
    .where(and(eq(feedback.orgId, orgId), gte(feedback.createdAt, since)));
  const fb = { didnt_help: 0, explain_differently: 0 };
  for (const r of fbRows) {
    if (r.kind === 'didnt_help') fb.didnt_help++;
    else if (r.kind === 'explain_differently') fb.explain_differently++;
  }

  const incidents = await db
    .select({ id: trustIncidents.id })
    .from(trustIncidents)
    .where(and(eq(trustIncidents.orgId, orgId), eq(trustIncidents.kind, 'false_all_clear'), gte(trustIncidents.createdAt, since)));

  return {
    window_days: windowDays,
    narrated: rows.length,
    verdicts,
    confidence,
    feedback: fb,
    class1_incidents: incidents.length,
    summary: buildSummary(rows.length, confidence, verdicts, incidents.length, windowDays),
  };
}

function buildSummary(
  narrated: number,
  confidence: TrackRecord['confidence'],
  verdicts: TrackRecord['verdicts'],
  class1: number,
  windowDays: number,
): string {
  if (narrated === 0) return `Nothing to report yet in the last ${windowDays} days.`;

  const withConfidence = confidence.high + confidence.medium + confidence.low;
  const certainPct = withConfidence > 0 ? Math.round((confidence.high / withConfidence) * 100) : null;
  const flagged = verdicts.cannot_tell + confidence.low;

  const parts: string[] = [];
  if (certainPct !== null) {
    parts.push(`In the last ${windowDays} days I was certain ${certainPct}% of the time`);
  } else {
    parts.push(`Over the last ${windowDays} days`);
  }
  if (flagged > 0) parts.push(`and told you when I wasn't (${flagged} time${flagged === 1 ? '' : 's'})`);

  let line = `${parts.join(' ')}.`;
  if (class1 > 0) {
    line += ` I got ${class1} all-clear${class1 === 1 ? '' : 's'} wrong and said so.`;
  } else {
    line += ` No false all-clears.`;
  }
  return line;
}
