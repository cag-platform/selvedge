import { verdictToStatus, type Verdict } from './verdict.js';
import type { EdgeStatus } from '../components/SelvedgeEdge.js';
import type { DetailLevel } from '../../shared/types/pack.js';

/**
 * The situation card's data shape and its two register-independent rules: which
 * edge a live event wears, and whether the technical line shows. Kept pure and
 * apart from the component so both are unit-testable without a DOM.
 */

/**
 * The change→break correlation, when the break lined up against a recent change.
 * `plain` is a lead the owner can act on; `technical` carries the caveat that
 * this is correlation, never confirmed cause.
 */
export type Correlation = {
  changeEventId: string;
  changeType: string;
  occurredAt: string;
  minutesBefore: number;
  plain: string;
  technical: string;
};

export type SituationEvent = {
  id: string;
  projectId: string | null;
  project_name?: string | null;
  eventId: string;
  eventType: string;
  fragment: string | null;
  technicalDetail: string | null;
  verdict?: Verdict | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  kind?: string | null;
  detail_level?: DetailLevel | null;
  correlation?: Correlation | null;
  occurredAt: string;
};

/**
 * The card's edge. A verdict is the fixed vocabulary and always wins. Without
 * one (low-tier TEMPLATE events carry no verdict), fall back by event family —
 * and default to `working`, never `healthy`, so an unclassified event is never
 * dressed as a false all-clear.
 */
export function situationEdge(ev: Pick<SituationEvent, 'verdict' | 'eventType'>): EdgeStatus {
  if (ev.verdict) return verdictToStatus(ev.verdict);
  const t = ev.eventType;
  if (t === 'runtime.health_failing' || t === 'deploy.failed_nothing_serving' || t === 'runtime.error_rate_spike') return 'needs';
  if (t.startsWith('runtime.recovered') || t.endsWith('.succeeded')) return 'healthy';
  return 'working';
}

/**
 * WHAT THE CARD SAYS WHEN NOBODY WROTE THE SENTENCE.
 *
 * The fallback used to be "Something changed." — three words that invent a
 * fact. Half the event families this card renders are not changes: a failed
 * deploy left the old version serving, a recovery undid a change, a health
 * check that has been red for an hour changed nothing at all. And it threw away
 * the one thing a narration-less card definitely knows, which is its own event
 * type, in exchange for saying something untrue.
 *
 * So: no narration is reported as no narration, and the machine name rides
 * along in the technical register where a machine name belongs. That is a
 * missing sentence, said out loud — a person can still tell what arrived, and
 * nothing on the card claims more than it has.
 */
export function fragmentLine(ev: Pick<SituationEvent, 'fragment'>): string | null {
  const written = ev.fragment?.trim();
  return written ? written : null;
}

export const NO_FRAGMENT = 'This one arrived without a description.';

/**
 * How the technical line rides along, by register:
 *   plain_only        → never (the narration omits it at that register anyway)
 *   plain_expandable  → present but collapsed behind a "why" reveal
 *   technical_forward → present and shown inline
 * `absent` when there is no technical line to show at all.
 */
export type TechnicalPresentation = 'absent' | 'collapsed' | 'inline';

export function technicalPresentation(
  detailLevel: DetailLevel | null | undefined,
  technicalDetail: string | null | undefined,
): TechnicalPresentation {
  const level: DetailLevel = detailLevel ?? 'plain_expandable';
  if (!technicalDetail || level === 'plain_only') return 'absent';
  return level === 'technical_forward' ? 'inline' : 'collapsed';
}
