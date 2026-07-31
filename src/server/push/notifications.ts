import type { ComposedDigest } from '../digest/compose.js';
import type { PushNotification } from './types.js';

/**
 * The morning brief as a push: the body IS the headline + the top item,
 * verdict-first (the top open thread is the most important attention item).
 * Tap deep-links to Today, or to the top item's project when there is one.
 */
export function morningBriefNotification(digest: ComposedDigest): PushNotification {
  const top = digest.openThreads[0];
  const body = top?.summary ? `${digest.headline} — ${top.summary}` : digest.headline;
  return {
    title: 'Your morning brief',
    body,
    interruptionLevel: 'active',
    data: top?.project_id ? { project_id: top.project_id } : {},
  };
}

/**
 * An immediate critical push (failures / ⚡ routing rows). The fragment is
 * already verdict-first. Time-sensitive so it can break through per the
 * routing table's quiet-hours-override rows (routing already decided this
 * narration is PUSH).
 */
export function criticalNotification(fragment: string, projectId: string | null): PushNotification {
  return {
    title: 'Needs you',
    body: fragment,
    interruptionLevel: 'time-sensitive',
    data: projectId ? { project_id: projectId } : {},
  };
}
