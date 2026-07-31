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
